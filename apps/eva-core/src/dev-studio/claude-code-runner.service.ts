import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationsService } from '../integrations/integrations.service';
import { PersistentShell, ShellProcess } from '../agent/sandbox-shell';
import { imageCandidates, machineSpecForRole } from './agent-machines';

const execFileAsync = promisify(execFile);

/** How long a task-scoped container survives after the run finishes, for inspection. */
const CONTAINER_GRACE_MS = 5 * 60 * 1000;

const CREDENTIAL_PROVIDER = 'claude_code';

/** Auth methods the user can choose the first time a code agent needs Claude Code. */
export type ClaudeAuthMethod = 'oauth' | 'api_key' | 'org';

export interface ClaudeAuthOption {
  method: ClaudeAuthMethod;
  label: string;
  description: string;
  /** Env var the token is injected as inside the container. */
  envVar: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  recommended?: boolean;
  /** Short hint shown in the UI about where to get this token. */
  hint: string;
}

/** The 3 options surfaced when a Claude Code machine is provisioned for the first time. */
export const CLAUDE_AUTH_OPTIONS: ClaudeAuthOption[] = [
  {
    method: 'oauth',
    label: 'Token de suscripción (OAuth)',
    description: 'Usa tu plan Max/Pro ya contratado. No paga por token de API.',
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    recommended: true,
    hint: 'Genera el token con `claude setup-token` en tu máquina y pégalo aquí.',
  },
  {
    method: 'api_key',
    label: 'API key de Anthropic',
    description: 'Pay-per-token con una API key (sk-ant-…).',
    envVar: 'ANTHROPIC_API_KEY',
    hint: 'Crea una key en console.anthropic.com → API Keys.',
  },
  {
    method: 'org',
    label: 'Credencial de la organización',
    description: 'Token de suscripción compartido a nivel organización.',
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    hint: 'Token OAuth de la cuenta de la organización (claude setup-token).',
  },
];

interface StoredClaudeCredential {
  method: ClaudeAuthMethod;
  token: string;
}

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  /** Final result summary as reported by Claude Code, if any. */
  resultSummary?: string;
  error?: string;
  /** True when the failure looks like an auth/login problem (bad/expired token). */
  authFailed?: boolean;
}

export interface AuthCheckResult {
  ok: boolean;
  /** Human-readable reason when not ok. */
  error?: string;
  /** True when the failure is specifically an auth/login error (vs infra). */
  authFailed?: boolean;
}

export interface ClaudeRunOptions {
  orgId: string;
  taskId: string;
  prompt: string;
  /** System / role context prepended to the prompt. */
  context?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * Stable key of the agent's persistent machine to exec into (typically the
   * dev_agents.id). When set, the task runs inside the agent's already-booted
   * container instead of a throwaway per-task one.
   */
  machineKey?: string;
  /** Agent role — selects the pre-baked image when a machine must be created. */
  role?: string;
  /** Streamed, human-readable log lines (thoughts, tool calls, text). */
  onEvent?: (ev: { type: string; text: string; raw?: unknown }) => void | Promise<void>;
}

export interface BootMachineOptions {
  orgId: string;
  /** Stable machine key (typically the dev_agents.id). */
  key: string;
  role: string;
  /** Streamed boot events (booting/ready/failed). */
  onEvent?: (ev: { type: string; text: string }) => void | Promise<void>;
}

export interface BootMachineResult {
  ok: boolean;
  /** Container name (`docker ps`). */
  containerName?: string;
  /** Resolved image actually used. */
  image?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_MAX_TURNS = 40;

/**
 * Runs Claude Code headless inside a per-task Docker container (eva-claude-sandbox)
 * for Dev Studio code agents. The org's stored credential (OAuth subscription token,
 * Anthropic API key, or org credential) is injected as an env var — never into argv,
 * never logged. Focus path: OAuth subscription token.
 */
interface ClaudeContainer {
  name: string;
  hostDir: string;
  image: string;
  role?: string;
  /** True when the auth token was injected at create time (claude can run). */
  hasToken: boolean;
  /** Session-scoped machines live until explicitly destroyed; task-scoped ones reap. */
  sessionScoped: boolean;
  shells: Map<number, PersistentShell>;
  reapTimer?: NodeJS.Timeout;
}

@Injectable()
export class ClaudeCodeRunnerService implements OnModuleDestroy {
  private readonly logger = new Logger(ClaudeCodeRunnerService.name);
  private dockerOk: boolean | null = null;

  /**
   * Live named containers, keyed either by a stable machine key (dev_agents.id,
   * session-scoped) or by a backing taskId (task-scoped). Used for streaming +
   * terminal access.
   */
  private readonly containers = new Map<string, ClaudeContainer>();

  /** Cache of `docker image inspect` results per image tag. */
  private readonly imageCache = new Map<string, boolean>();

  constructor(@Optional() private readonly integrations?: IntegrationsService) {}

  async onModuleDestroy(): Promise<void> {
    for (const [taskId] of this.containers) {
      await this.destroyContainer(taskId).catch(() => undefined);
    }
  }

  // ── Credentials ──────────────────────────────────────────────────────────

  /** Whether the org has a Claude Code credential configured. */
  async hasCredential(orgId: string): Promise<boolean> {
    return (await this.resolveCredential(orgId)) !== null;
  }

  async resolveCredential(orgId: string): Promise<StoredClaudeCredential | null> {
    if (!this.integrations) return null;
    const raw = await this.integrations.getSecret(orgId, 'credential', CREDENTIAL_PROVIDER).catch(() => null);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredClaudeCredential;
      if (parsed?.token && parsed?.method) return parsed;
    } catch {
      // Back-compat: a bare token stored as the secret → assume OAuth.
      return { method: 'oauth', token: raw };
    }
    return null;
  }

  /** Persist the chosen auth method + token for the org. */
  async saveCredential(orgId: string, method: ClaudeAuthMethod, token: string): Promise<void> {
    if (!this.integrations) throw new Error('IntegrationsService no disponible');
    const payload: StoredClaudeCredential = { method, token: token.trim() };
    await this.integrations.upsert({
      orgId,
      kind: 'credential',
      provider: CREDENTIAL_PROVIDER,
      secret: JSON.stringify(payload),
    });
  }

  private envVarFor(method: ClaudeAuthMethod): 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY' {
    return method === 'api_key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
  }

  /** Heuristic: does this output/stderr look like a Claude auth/login failure? */
  private static readonly AUTH_ERR_RE =
    /authentication|invalid api key|invalid x-api-key|unauthorized|\b401\b|oauth|token (?:expired|invalid)|not logged in|please run.*login|credit balance/i;

  private isAuthError(text: string | undefined): boolean {
    return !!text && ClaudeCodeRunnerService.AUTH_ERR_RE.test(text);
  }

  // ── Auth verification ───────────────────────────────────────────────────────

  /**
   * Validate a token BEFORE storing it: run a 1-turn `claude -p` in an ephemeral
   * container. Returns `authFailed:true` only when the error is clearly an auth
   * problem; infra issues (no docker / no image) resolve `ok:true` so they never
   * block saving a credential the user can't otherwise verify.
   */
  async verifyToken(method: ClaudeAuthMethod, token: string): Promise<AuthCheckResult> {
    if (!(await this.dockerAvailable())) return { ok: true, error: 'docker-unavailable: no verificado' };
    const image = await this.resolveImage('project_manager'); // base image is enough
    if (!image) return { ok: true, error: 'image-unavailable: no verificado' };
    const envVar = this.envVarFor(method);
    return this.probe(
      ['run', '--rm', '--network', 'bridge', '-e', envVar, image],
      { ...process.env, [envVar]: token.trim() },
    );
  }

  /** Verify the credential works inside an already-booted machine (by key). */
  async verifyAuth(orgId: string, key: string): Promise<AuthCheckResult> {
    const c = this.containers.get(key);
    if (!c) return { ok: false, error: 'NO_MACHINE' };
    if (!c.hasToken) return { ok: false, authFailed: true, error: 'NO_TOKEN: la máquina se levantó sin credencial' };
    return this.probe(['exec', c.name], process.env);
  }

  /**
   * Shared probe: append the headless 1-turn claude command and classify the
   * outcome. `prefix` is everything up to (but excluding) the image/container.
   */
  private async probe(prefix: string[], env: NodeJS.ProcessEnv): Promise<AuthCheckResult> {
    const claudeArgs = ['claude', '-p', 'Responde únicamente: OK', '--max-turns', '1', '--output-format', 'json'];
    try {
      const { stdout } = await execFileAsync('docker', [...prefix, ...claudeArgs], { timeout: 90_000, env });
      if (this.isAuthError(stdout)) return { ok: false, authFailed: true, error: 'Token rechazado por la API de Anthropic' };
      return { ok: true };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const text = `${e.stderr ?? ''}\n${e.stdout ?? ''}\n${e.message ?? ''}`;
      if (this.isAuthError(text)) return { ok: false, authFailed: true, error: 'Token inválido o expirado' };
      // Inconclusive (timeout, network, etc.) — don't claim an auth failure.
      return { ok: false, error: (e.message ?? 'probe failed').slice(0, 200) };
    }
  }

  // ── Docker availability ────────────────────────────────────────────────────

  private async dockerAvailable(): Promise<boolean> {
    if (this.dockerOk !== null) return this.dockerOk;
    this.dockerOk = await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    return this.dockerOk;
  }

  async imageAvailable(image: string): Promise<boolean> {
    const cached = this.imageCache.get(image);
    if (cached !== undefined) return cached;
    const ok = await execFileAsync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    this.imageCache.set(image, ok);
    return ok;
  }

  /**
   * First locally-available image for a role: role image → base → legacy.
   * Returns null when none of the candidates is built.
   */
  async resolveImage(role: string): Promise<string | null> {
    for (const candidate of imageCandidates(role)) {
      if (await this.imageAvailable(candidate)) return candidate;
    }
    return null;
  }

  // ── Machine lifecycle ───────────────────────────────────────────────────────

  /**
   * Eagerly boot the agent's persistent machine (called when the agent registers
   * for a session). Picks the role's pre-baked image, injects the org credential
   * if available, and keeps the container alive for the whole session so the user
   * can watch it come up and open a terminal into it — even before any task runs.
   */
  async bootMachine(opts: BootMachineOptions): Promise<BootMachineResult> {
    const emit = (type: string, text: string) => { void opts.onEvent?.({ type, text }); };

    if (!(await this.dockerAvailable())) {
      emit('failed', 'Docker no disponible en este nodo');
      return { ok: false, error: 'Docker no disponible en este nodo' };
    }

    const existing = this.containers.get(opts.key);
    if (existing) {
      emit('ready', `Máquina ya activa (${existing.image})`);
      return { ok: true, containerName: existing.name, image: existing.image };
    }

    const image = await this.resolveImage(opts.role);
    if (!image) {
      const spec = machineSpecForRole(opts.role);
      const err = `Imagen ${spec.image} ausente — construye con "./docker/agents/build.sh"`;
      emit('failed', err);
      return { ok: false, error: err };
    }

    // Notice when we fell back off the role's dedicated image (its toolchain is
    // missing) so the user knows why a backend agent lacks python, etc.
    const preferred = machineSpecForRole(opts.role).image;
    if (image !== preferred) {
      emit('fallback', `Imagen ${preferred} no construida — usando ${image} (sin toolchain especializado)`);
    }

    emit('booting', `Levantando máquina (${image})…`);
    const credential = await this.resolveCredential(opts.orgId);
    const container = await this.createContainer({
      key: opts.key,
      image,
      role: opts.role,
      sessionScoped: true,
      credential,
    });
    if (!container) {
      emit('failed', 'No se pudo crear el contenedor');
      return { ok: false, error: 'No se pudo crear el contenedor', image };
    }

    emit('ready', `Máquina lista (${image})`);
    return { ok: true, containerName: container.name, image };
  }

  /** Destroy an agent's persistent machine (e.g. when the session ends). */
  async destroyMachine(key: string): Promise<void> {
    await this.destroyContainer(key);
  }

  // ── Run ────────────────────────────────────────────────────────────────────

  async run(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
    if (!(await this.dockerAvailable())) {
      return { ok: false, text: '', error: 'Docker no disponible en este nodo' };
    }

    const credential = await this.resolveCredential(opts.orgId);
    if (!credential) {
      return { ok: false, text: '', error: 'NO_CREDENTIAL: el org no tiene credencial de Claude Code configurada' };
    }

    const role = opts.role ?? 'backend';
    const image = await this.resolveImage(role);
    if (!image) {
      const spec = machineSpecForRole(role);
      return {
        ok: false,
        text: '',
        error: `Imagen ${spec.image} ausente — construye con "./docker/agents/build.sh"`,
      };
    }

    const fullPrompt = opts.context ? `${opts.context}\n\n---\n\n${opts.prompt}` : opts.prompt;

    // Prefer the agent's persistent machine (machineKey); fall back to a
    // throwaway per-task container keyed by taskId.
    const key = opts.machineKey ?? opts.taskId;
    const sessionScoped = Boolean(opts.machineKey);

    let container = this.containers.get(key);
    // A session machine booted before the credential existed has no token — the
    // claude CLI can't authenticate. Recreate it now that we have a credential.
    if (container && !container.hasToken) {
      await this.destroyContainer(key);
      container = undefined;
    }
    if (!container) {
      container = (await this.createContainer({ key, image, role, sessionScoped, credential })) ?? undefined;
    }
    if (!container) {
      return { ok: false, text: '', error: 'No se pudo crear el contenedor de Claude Code' };
    }

    const execArgs = [
      'exec',
      '-w', '/work',
      container.name,
      'claude',
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--max-turns', String(opts.maxTurns ?? DEFAULT_MAX_TURNS),
    ];

    const result = await this.spawnAndStream(execArgs, process.env, opts);
    // Surface auth failures distinctly so the orchestrator can reopen provisioning
    // instead of treating an expired token as a generic task failure.
    if (!result.ok && this.isAuthError(result.error)) {
      result.authFailed = true;
      result.error = `AUTH_FAILED: ${result.error ?? 'credencial de Claude Code rechazada'}`;
    }
    // Task-scoped containers reap after a grace period; session machines persist
    // until the session ends (destroyMachine) or the process exits.
    if (!container.sessionScoped) this.scheduleReap(key);
    return result;
  }

  /** Create a long-lived named container with the role's image + optional token. */
  private async createContainer(input: {
    key: string;
    image: string;
    role?: string;
    sessionScoped: boolean;
    credential: StoredClaudeCredential | null;
  }): Promise<ClaudeContainer | null> {
    const { key, image, role, sessionScoped, credential } = input;
    const existing = this.containers.get(key);
    if (existing) {
      if (existing.reapTimer) { clearTimeout(existing.reapTimer); existing.reapTimer = undefined; }
      return existing;
    }

    const spec = machineSpecForRole(role ?? 'backend');
    const name = `eva-agent-${(role ?? 'agent').slice(0, 10)}-${key.slice(0, 8)}-${Date.now().toString(36)}`;
    const hostDir = await mkdtemp(join(tmpdir(), 'eva-agent-'));

    const envVar = credential ? this.envVarFor(credential.method) : null;
    const runArgs = [
      'run', '-d', '--name', name,
      '--network', 'bridge',
      '--memory', spec.memory,
      '--cpus', spec.cpus,
      '-v', `${hostDir}:/work`,
      '-w', '/work',
      '-e', 'CI',
    ];
    if (envVar) runArgs.push('-e', envVar);
    runArgs.push(image, 'tail', '-f', '/dev/null');

    const childEnv: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
    if (envVar && credential) childEnv[envVar] = credential.token;

    try {
      await execFileAsync('docker', runArgs, { timeout: 120_000, env: childEnv });
    } catch (err) {
      await rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
      this.logger.warn(`agent container create failed for ${key}: ${(err as Error).message.slice(0, 200)}`);
      return null;
    }

    const container: ClaudeContainer = {
      name, hostDir, image, role, hasToken: Boolean(envVar), sessionScoped, shells: new Map(),
    };
    this.containers.set(key, container);
    this.logger.log(`agent container ${name} (${image}) ready for ${key}`);
    return container;
  }

  private scheduleReap(key: string): void {
    const container = this.containers.get(key);
    if (!container) return;
    if (container.reapTimer) clearTimeout(container.reapTimer);
    container.reapTimer = setTimeout(() => { void this.destroyContainer(key); }, CONTAINER_GRACE_MS);
  }

  private async destroyContainer(key: string): Promise<void> {
    const container = this.containers.get(key);
    if (!container) return;
    this.containers.delete(key);
    if (container.reapTimer) clearTimeout(container.reapTimer);
    for (const shell of container.shells.values()) shell.close();
    await execFileAsync('docker', ['rm', '-f', container.name], { timeout: 20_000 }).catch(() => undefined);
    await rm(container.hostDir, { recursive: true, force: true }).catch(() => undefined);
    this.logger.log(`agent container for ${key} destroyed`);
  }

  // ── Live terminal access ────────────────────────────────────────────────────

  /**
   * Attach to a live shell inside the agent's Claude Code container. Mirrors
   * SandboxService.attachShellStream so the gateway can use either transparently.
   */
  attachShellStream(key: string, shellNum = 0): {
    initialBuffer: string;
    subscribe: (cb: (chunk: string) => void) => () => void;
    write: (data: string) => void;
  } | null {
    const container = this.containers.get(key);
    if (!container) return null;
    let shell = container.shells.get(shellNum);
    if (!shell) {
      const proc = this.createShellProcess(container.name);
      shell = new PersistentShell(proc);
      container.shells.set(shellNum, shell);
    }
    return {
      initialBuffer: shell.getBuffer(),
      subscribe: (cb) => shell!.subscribe(cb),
      write: (data) => shell!.writeRaw(data),
    };
  }

  /** Whether a live container exists for this key (for the terminal UI gating). */
  hasContainer(key: string): boolean {
    return this.containers.has(key);
  }

  /** Live machine info for a key (image + container name), or null if not booted. */
  machineInfo(key: string): { containerName: string; image: string; role?: string } | null {
    const c = this.containers.get(key);
    return c ? { containerName: c.name, image: c.image, role: c.role } : null;
  }

  private createShellProcess(containerName: string): ShellProcess {
    const boot =
      "command -v script >/dev/null 2>&1 && exec script -qfc 'exec bash 2>&1 || exec sh 2>&1' /dev/null " +
      '|| exec bash 2>&1 || exec sh 2>&1';
    const child = spawn('docker', ['exec', '-i', containerName, 'sh', '-c', boot], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let exited = false;
    child.on('exit', () => { exited = true; });
    child.on('error', () => { exited = true; });
    const cbs: Array<(c: string) => void> = [];
    const emit = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const cb of cbs) cb(s);
    };
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
    return {
      write: (d) => { try { child.stdin?.write(d); } catch { /* pipe closed */ } },
      onData: (cb) => { cbs.push(cb); },
      kill: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
      get exited() { return exited; },
      onExit: (cb) => { child.on('exit', () => cb()); },
    };
  }

  private spawnAndStream(
    args: string[],
    env: NodeJS.ProcessEnv,
    opts: ClaudeRunOptions,
  ): Promise<ClaudeRunResult> {
    return new Promise<ClaudeRunResult>((resolve) => {
      const child = spawn('docker', args, { env });
      let stdoutBuf = '';
      let stderrBuf = '';
      let resultText = '';
      let resultSummary = '';
      let isError = false;
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        child.kill('SIGKILL');
        finish({ ok: false, text: resultText, error: `Timeout tras ${(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s` });
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const finish = (r: ClaudeRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(r);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          const parsed = this.handleStreamLine(line, opts);
          if (parsed?.resultText) resultText = parsed.resultText;
          if (parsed?.resultSummary) resultSummary = parsed.resultSummary;
          if (parsed?.isError) isError = true;
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
      });

      child.on('error', (err) => {
        finish({ ok: false, text: resultText, error: `spawn docker falló: ${err.message}` });
      });

      child.on('close', (code) => {
        const ok = code === 0 && !isError;
        finish({
          ok,
          text: resultText || resultSummary,
          resultSummary: resultSummary || undefined,
          error: ok ? undefined : (stderrBuf.trim().slice(-600) || `claude salió con código ${code}`),
        });
      });
    });
  }

  /**
   * Parse one line of Claude Code stream-json output and forward a human-readable
   * event. Returns extracted result fields when present.
   * Stream schema: { type: 'system'|'assistant'|'user'|'result', ... }.
   */
  private handleStreamLine(
    line: string,
    opts: ClaudeRunOptions,
  ): { resultText?: string; resultSummary?: string; isError?: boolean } | null {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = String(ev.type ?? '');
    const emit = (t: string, text: string) => { void opts.onEvent?.({ type: t, text, raw: ev }); };

    if (type === 'assistant' || type === 'user') {
      const msg = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
      const content = msg?.content ?? [];
      for (const block of content) {
        const btype = String(block.type ?? '');
        if (btype === 'text' && typeof block.text === 'string') {
          emit('text', block.text);
        } else if (btype === 'tool_use') {
          const name = String(block.name ?? 'tool');
          const input = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
          emit('tool_call', `${name}(${input})`);
        } else if (btype === 'tool_result') {
          const out = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          emit('tool_result', out.slice(0, 300));
        }
      }
      return null;
    }

    if (type === 'result') {
      const subtype = String(ev.subtype ?? '');
      const isError = subtype.includes('error') || ev.is_error === true;
      const text = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '');
      emit(isError ? 'error' : 'final', text.slice(0, 1000));
      return { resultText: text, resultSummary: text.slice(0, 500), isError };
    }

    if (type === 'system') {
      emit('event', `claude:${String(ev.subtype ?? 'init')}`);
    }
    return null;
  }
}
