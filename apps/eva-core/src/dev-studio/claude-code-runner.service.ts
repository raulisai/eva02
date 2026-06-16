import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationsService } from '../integrations/integrations.service';
import { PersistentShell, ShellProcess } from '../agent/sandbox-shell';

const execFileAsync = promisify(execFile);

/** How long a task's container survives after the run finishes, for inspection. */
const CONTAINER_GRACE_MS = 5 * 60 * 1000;

const CLAUDE_IMAGE = process.env.EVA_CLAUDE_SANDBOX_IMAGE || 'eva-claude-sandbox';
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
}

export interface ClaudeRunOptions {
  orgId: string;
  taskId: string;
  prompt: string;
  /** System / role context prepended to the prompt. */
  context?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /** Streamed, human-readable log lines (thoughts, tool calls, text). */
  onEvent?: (ev: { type: string; text: string; raw?: unknown }) => void | Promise<void>;
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
  shells: Map<number, PersistentShell>;
  reapTimer?: NodeJS.Timeout;
}

@Injectable()
export class ClaudeCodeRunnerService implements OnModuleDestroy {
  private readonly logger = new Logger(ClaudeCodeRunnerService.name);
  private dockerOk: boolean | null = null;

  /** Live per-task containers (named, persistent) for streaming + terminal access. */
  private readonly containers = new Map<string, ClaudeContainer>();

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

  // ── Docker availability ────────────────────────────────────────────────────

  private async dockerAvailable(): Promise<boolean> {
    if (this.dockerOk !== null) return this.dockerOk;
    this.dockerOk = await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    return this.dockerOk;
  }

  async imageAvailable(): Promise<boolean> {
    return execFileAsync('docker', ['image', 'inspect', CLAUDE_IMAGE, '--format', '{{.Id}}'], { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
  }

  // ── Run ────────────────────────────────────────────────────────────────────

  async run(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
    if (!(await this.dockerAvailable())) {
      return { ok: false, text: '', error: 'Docker no disponible en este nodo' };
    }
    if (!(await this.imageAvailable())) {
      return {
        ok: false,
        text: '',
        error: `Imagen ${CLAUDE_IMAGE} ausente — construye "docker build -t eva-claude-sandbox docker/claude-sandbox"`,
      };
    }

    const credential = await this.resolveCredential(opts.orgId);
    if (!credential) {
      return { ok: false, text: '', error: 'NO_CREDENTIAL: el org no tiene credencial de Claude Code configurada' };
    }

    const envVar = this.envVarFor(credential.method);
    const fullPrompt = opts.context ? `${opts.context}\n\n---\n\n${opts.prompt}` : opts.prompt;

    // Named, persistent container so a live terminal can `docker exec` into the
    // same /work while/after the agent runs. Token injected at create time.
    const container = await this.createContainer(opts.taskId, envVar, credential.token);
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
    // Keep the container around briefly so the user can still inspect it.
    this.scheduleReap(opts.taskId);
    return result;
  }

  /** Create a long-lived named container with the token baked into its env. */
  private async createContainer(taskId: string, envVar: string, token: string): Promise<ClaudeContainer | null> {
    const existing = this.containers.get(taskId);
    if (existing) {
      if (existing.reapTimer) { clearTimeout(existing.reapTimer); existing.reapTimer = undefined; }
      return existing;
    }

    const name = `eva-claude-${taskId.slice(0, 8)}-${Date.now().toString(36)}`;
    const hostDir = await mkdtemp(join(tmpdir(), 'eva-claude-'));
    try {
      await execFileAsync('docker', [
        'run', '-d', '--name', name,
        '--network', 'bridge',
        '--memory', '2g',
        '--cpus', '2',
        '-v', `${hostDir}:/work`,
        '-w', '/work',
        '-e', envVar,
        '-e', 'CI',
        CLAUDE_IMAGE,
        'tail', '-f', '/dev/null',
      ], { timeout: 60_000, env: { ...process.env, [envVar]: token, CI: '1' } });
    } catch (err) {
      await rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
      this.logger.warn(`claude container create failed for task ${taskId}: ${(err as Error).message.slice(0, 200)}`);
      return null;
    }

    const container: ClaudeContainer = { name, hostDir, shells: new Map() };
    this.containers.set(taskId, container);
    this.logger.log(`claude container ${name} ready for task ${taskId}`);
    return container;
  }

  private scheduleReap(taskId: string): void {
    const container = this.containers.get(taskId);
    if (!container) return;
    if (container.reapTimer) clearTimeout(container.reapTimer);
    container.reapTimer = setTimeout(() => { void this.destroyContainer(taskId); }, CONTAINER_GRACE_MS);
  }

  private async destroyContainer(taskId: string): Promise<void> {
    const container = this.containers.get(taskId);
    if (!container) return;
    this.containers.delete(taskId);
    if (container.reapTimer) clearTimeout(container.reapTimer);
    for (const shell of container.shells.values()) shell.close();
    await execFileAsync('docker', ['rm', '-f', container.name], { timeout: 20_000 }).catch(() => undefined);
    await rm(container.hostDir, { recursive: true, force: true }).catch(() => undefined);
    this.logger.log(`claude container for task ${taskId} destroyed`);
  }

  // ── Live terminal access ────────────────────────────────────────────────────

  /**
   * Attach to a live shell inside the agent's Claude Code container. Mirrors
   * SandboxService.attachShellStream so the gateway can use either transparently.
   */
  attachShellStream(taskId: string, shellNum = 0): {
    initialBuffer: string;
    subscribe: (cb: (chunk: string) => void) => () => void;
    write: (data: string) => void;
  } | null {
    const container = this.containers.get(taskId);
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

  /** Whether a live container exists for this task (for the terminal UI gating). */
  hasContainer(taskId: string): boolean {
    return this.containers.has(taskId);
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
