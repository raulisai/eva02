import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationsService } from '../integrations/integrations.service';
import { PersistentShell, ShellProcess } from '../agent/sandbox-shell';
import { imageCandidates, machineSpecForRole } from './agent-machines';
import { GithubService } from './github/github.service';

const execFileAsync = promisify(execFile);

/** How long a task-scoped container survives after the run finishes, for inspection. */
const CONTAINER_GRACE_MS = 5 * 60 * 1000;

const CREDENTIAL_PROVIDER = 'claude_code';
const CLAUDE_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';

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

export type OAuthStatus = 'scanning_url' | 'waiting_for_code' | 'waiting_callback' | 'completed' | 'failed';

export interface OAuthFlowState {
  status: OAuthStatus;
  /** The URL the user must open in their browser to authenticate. */
  url: string | null;
  /** True once the token was captured and saved to org_integrations. */
  configured: boolean;
  error: string | null;
}

interface PendingOAuth {
  proc: ChildProcess;
  orgId: string;
  /** Container the login process runs in — read to recover the token post-login. */
  containerName: string;
  state: OAuthFlowState;
  /** Accumulated raw output (ANSI-stripped) for multi-line URL reconstruction. */
  fullBuf: string;
  /** Resolve the startOAuthFlow() promise once we have a URL. */
  onUrl: ((url: string) => void) | null;
  onError: ((err: string) => void) | null;
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

/** Stable git author identity for an agent (who did the change in history). */
export interface GitIdentity {
  name: string;
  email: string;
}

export interface SetupAgentRepoOptions {
  orgId: string;
  /** Stable machine key (dev_agents.id) — the agent's persistent container. */
  machineKey: string;
  role: string;
  /** https://github.com/owner/repo */
  repoUrl: string;
  /** Org GitHub PAT — embedded in the origin remote, never logged. */
  token: string;
  /** Agent branch to check out / continue (e.g. agent/ada/iter-1-x). */
  branch: string;
  /** Integration branch new agent branches fork from (e.g. develop). */
  baseBranch: string;
  identity: GitIdentity;
}

export interface CommitPushOptions {
  machineKey: string;
  token: string;
  branch: string;
  message: string;
  identity: GitIdentity;
}

export interface GitOpResult {
  ok: boolean;
  error?: string;
}

export interface CommitPushResult {
  ok: boolean;
  pushed: boolean;
  headSha?: string;
  /** 'NO_CHANGES' when the agent produced no file changes (ok=true, pushed=false). */
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
export class ClaudeCodeRunnerService implements OnModuleInit, OnModuleDestroy {
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

  /** In-flight OAuth device-code flows keyed by machine key. */
  private readonly pendingOAuth = new Map<string, PendingOAuth>();

  constructor(@Optional() private readonly integrations?: IntegrationsService) {}

  /**
   * On startup, scan Docker for any `eva-agent-*` containers that survived a
   * process restart and register them so terminal attach and task runs work
   * immediately without waiting for a full session re-boot.
   */
  async onModuleInit(): Promise<void> {
    if (!(await this.dockerAvailable())) return;
    try {
      const { stdout } = await execFileAsync('docker', [
        'ps', '--filter', 'name=eva-agent-', '--format', '{{.Names}}\t{{.Image}}',
      ], { timeout: 10_000, env: process.env });

      for (const line of stdout.split('\n')) {
        const [name, image] = line.trim().split('\t');
        if (!name || !image) continue;
        // Deterministic names: eva-agent-{uuid32} — extract key from name
        const m = /^eva-agent-([0-9a-f]{32})$/.exec(name);
        if (!m) continue;
        // Reconstruct UUID with dashes: 8-4-4-4-12
        const h = m[1];
        const key = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
        if (this.containers.has(key)) continue;
        this.containers.set(key, {
          name, image, hostDir: '', role: undefined,
          hasToken: false, sessionScoped: true, shells: new Map(),
        });
        this.logger.log(`[init] Reconnected orphaned container ${name} → key ${key.slice(0,8)}`);
      }
    } catch {
      // Docker not available or no matching containers — silently skip
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const [taskId] of this.containers) {
      await this.destroyContainer(taskId).catch(() => undefined);
    }
  }

  // ── Deterministic naming ───────────────────────────────────────────────────

  /**
   * Stable container name derived from the agent key (dev_agents.id).
   * Using a fixed name lets us reconnect to the same container after a
   * process restart without scanning Docker or storing the name elsewhere.
   * Format: eva-agent-{uuid32}  (32 hex chars, no dashes — Docker allows it).
   */
  private deterministicContainerName(key: string): string {
    return `eva-agent-${key.replace(/-/g, '').slice(0, 32)}`;
  }

  // ── Credentials ──────────────────────────────────────────────────────────

  /** Whether the org or a specific persistent machine has usable Claude Code auth. */
  async hasCredential(orgId: string, machineKey?: string): Promise<boolean> {
    if ((await this.resolveCredential(orgId)) !== null) return true;
    if (!machineKey) return false;
    return this.hasMachineAuth(machineKey);
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

  static extractOAuthUrlFromOutput(output: string): string | null {
    const normalized = this.normalizeTerminalOutput(output);
    const compact = this.trimOAuthPrompt(normalized.replace(/\s+/g, ''));

    for (const text of [normalized, compact]) {
      const match = /https:\/\/[a-z0-9.%-]*(?:anthropic\.com|claude\.ai)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*/i.exec(text);
      const candidate = match ? this.cleanOAuthUrlCandidate(match[0]) : null;
      if (candidate) return candidate;
    }

    const fragment = /(?:client_id=)?[A-Za-z0-9._~-]+&response_type=code&redirect_uri=https%3A%2F%2Fplatform\.claude\.com%2Foauth%2Fcode%2Fcallback[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*/i.exec(compact);
    if (!fragment) return null;

    const query = fragment[0].startsWith('client_id=') ? fragment[0] : `client_id=${fragment[0]}`;
    return this.cleanOAuthUrlCandidate(`${CLAUDE_OAUTH_AUTHORIZE_URL}?${query}`);
  }

  private static normalizeTerminalOutput(output: string): string {
    return output
      .replace(/\x1b]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)(.*?)\x1b]8;;(?:\x07|\x1b\\)/gs, '$1 $2')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[@-Z\\-_]/g, '')
      .replace(/\r/g, '\n');
  }

  private static trimOAuthPrompt(value: string): string {
    const promptMatch = /(?:Pastecodehere|Enter(?:the)?code|Code>)/i.exec(value);
    return promptMatch ? value.slice(0, promptMatch.index) : value;
  }

  private static cleanOAuthUrlCandidate(raw: string): string | null {
    const trimmed = this.trimOAuthPrompt(raw).replace(/[),.;]+$/, '');
    try {
      const url = new URL(trimmed);
      const hasCodeGrant =
        url.searchParams.get('response_type') === 'code' &&
        url.searchParams.has('redirect_uri') &&
        url.searchParams.has('code_challenge');
      return hasCodeGrant ? url.toString() : null;
    } catch {
      return null;
    }
  }

  // ── OAuth device-code flow ──────────────────────────────────────────────────

  /**
   * Start `claude setup-token` inside the agent's machine.
   * The CLI prints a URL the user must open in their browser. Once the user
   * authenticates, the CLI outputs the OAuth token, which we capture and save.
   *
   * Returns the auth URL once found in the process output (within 30 s),
   * or an error if the machine is missing / Docker is unavailable.
   */
  async startOAuthFlow(orgId: string, key: string): Promise<{ url: string } | { error: string }> {
    const c = this.containers.get(key);
    if (!c) return { error: 'La máquina del agente no está activa. Levántala primero.' };

    // Verify the container is actually running before trying exec.
    try {
      const { stdout: runState } = await execFileAsync('docker', [
        'inspect', '--format', '{{.State.Running}}', c.name,
      ], { timeout: 5_000, env: process.env });
      if (runState.trim() !== 'true') {
        return { error: `El contenedor ${c.name} no está corriendo. Reinicia la máquina del agente.` };
      }
    } catch {
      return { error: `No se puede acceder al contenedor ${c.name}. ¿Está Docker disponible?` };
    }

    // Verify claude is installed in the container.
    try {
      await execFileAsync('docker', ['exec', c.name, 'claude', '--version'], { timeout: 8_000, env: process.env });
    } catch {
      return { error: 'El binario `claude` no está instalado en la imagen del agente. Reconstruye la imagen con `./docker/agents/build.sh`.' };
    }

    // Cancel any previous pending flow for this key.
    const prev = this.pendingOAuth.get(key);
    if (prev) {
      try { prev.proc.kill('SIGKILL'); } catch { /* already dead */ }
      this.pendingOAuth.delete(key);
    }

    // Pre-seed Claude Code's config to skip the first-run interactive wizard.
    // Without this, `claude auth login` starts an Ink TUI that waits for keyboard
    // input we can't provide without a real PTY.
    try {
      await execFileAsync('docker', [
        'exec', c.name, 'sh', '-c',
        [
          'mkdir -p ~/.config/@anthropic-ai/claude-code ~/.claude',
          `printf '%s' '{"theme":"dark","hasCompletedOnboarding":true,"enabledFeatures":[]}' > ~/.config/@anthropic-ai/claude-code/settings.json`,
          `printf '%s' '{"theme":"dark","hasCompletedOnboarding":true,"enabledFeatures":[]}' > ~/.claude/settings.json`,
        ].join(' && '),
      ], { timeout: 10_000, env: process.env });
    } catch (e) {
      this.logger.warn(`[oauth:${key}] config pre-seed failed (non-fatal): ${(e as Error).message.slice(0, 80)}`);
    }

    return new Promise<{ url: string } | { error: string }>((resolve) => {
      // Pass `-i` so the container gets a connected stdin pipe — without it some
      // Claude CLI versions detect "no tty" and switch to a mode that never prints
      // the URL. Also strip ANSI codes so the URL regex works on Ink-rendered output.
      const proc = spawn(
        'docker',
        [
          'exec', '-i',
          '-e', 'TERM=dumb',
          '-e', 'NO_COLOR=1',
          '-e', 'CI=1',
          '-e', 'FORCE_COLOR=0',
          '-e', 'CLAUDE_CODE_DISABLE_TUI=1',
          '-e', 'COLUMNS=4096',
          '-e', 'LINES=40',
          c.name,
          'claude', 'auth', 'login',
        ],
        { env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', CI: '1', FORCE_COLOR: '0', CLAUDE_CODE_DISABLE_TUI: '1' } },
      );

      const pending: PendingOAuth = {
        proc,
        orgId,
        containerName: c.name,
        fullBuf: '',
        state: { status: 'scanning_url', url: null, configured: false, error: null },
        onUrl: (url) => resolve({ url }),
        onError: (err) => resolve({ error: err }),
      };
      this.pendingOAuth.set(key, pending);

      const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{30,}/;
      // Detect the "Paste code here" prompt that Claude Code shows in code-grant flow
      const CODE_PROMPT_RE = /paste\s+code\s+here|enter\s+(?:the\s+)?code|code\s*>/i;
      // `claude auth login` prints this once the code is exchanged successfully.
      // The token itself is NOT printed — it's written to the credential file.
      const LOGIN_OK_RE = /login\s+success|successfully\s+logged\s+in|authentication\s+success/i;

      let lineBuf = '';

      const tryFindUrl = () => {
        if (pending.state.status !== 'scanning_url') return;
        const url = ClaudeCodeRunnerService.extractOAuthUrlFromOutput(pending.fullBuf);
        if (url) {
          this.logger.log(`[oauth:${key}] URL encontrada: ${url.slice(0, 80)}…`);
          pending.state.url = url;
          pending.state.status = 'waiting_for_code';
          pending.onUrl?.(url);
          pending.onUrl = null; pending.onError = null;
        }
      };

      const onChunk = (chunk: Buffer) => {
        const raw = chunk.toString('utf8');
        const clean = ClaudeCodeRunnerService.normalizeTerminalOutput(raw);
        pending.fullBuf += clean;
        lineBuf += clean;

        // Process complete lines for logging + token detection
        let nl: number;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (!line) continue;
          this.logger.debug(`[oauth:${key}] ${line}`);

          // Token on its own line (completed flow where code was already sent)
          if (TOKEN_RE.test(line) && pending.state.status === 'waiting_callback') {
            const tm = TOKEN_RE.exec(line);
            if (tm) this.handleOAuthToken(key, pending, tm[0]);
          }
        }

        // After every chunk: try to extract the URL from the full buffer
        tryFindUrl();

        // Detect "Paste code here" prompt — the URL should have been found by now
        if (pending.state.status === 'scanning_url' && CODE_PROMPT_RE.test(clean)) {
          // We haven't found the URL yet but the process is asking for the code.
          // Try one more time with a broader window then fall through.
          tryFindUrl();
          if (pending.state.status === 'scanning_url') {
            // URL wasn't captured — resolve with a best-effort fragment so the
            // user at least knows to open the terminal.
            const snippet = pending.fullBuf.replace(/\s+/g, ' ').slice(-400);
            pending.onError?.(
              `La URL fue generada pero no pudo capturarse completa.\n` +
              `Usa la pestaña Terminal del agente → ejecuta: claude auth login\n` +
              `Salida hasta ahora: ${snippet}`,
            );
            pending.onUrl = null; pending.onError = null;
          }
        }

        // Detect token in the accumulated buffer (waiting_callback state)
        if (pending.state.status === 'waiting_callback' || pending.state.status === 'waiting_for_code') {
          TOKEN_RE.lastIndex = 0;
          const tm = TOKEN_RE.exec(pending.fullBuf);
          if (tm) this.handleOAuthToken(key, pending, tm[0]);
        }

        // "Login successful." — the CLI exchanged the code and wrote the token to
        // the credential file (it's NOT printed). Read it back from the container.
        if (pending.state.status !== 'completed' && LOGIN_OK_RE.test(clean)) {
          void this.finalizeOAuthFromContainer(key, pending);
        }
      };

      proc.stdout?.on('data', onChunk);
      proc.stderr?.on('data', onChunk);

      proc.on('error', (err) => {
        if (pending.state.status === 'scanning_url' || pending.state.status === 'waiting_for_code') {
          pending.onError?.(`Error ejecutando claude auth login: ${err.message}`);
          pending.onUrl = null; pending.onError = null;
        }
        pending.state.status = 'failed';
        pending.state.error = err.message;
        this.pendingOAuth.delete(key);
      });

      proc.on('close', (code) => {
        // Final flush — try to grab URL if we haven't yet
        if (pending.state.status === 'scanning_url') tryFindUrl();

        // Already done (token captured from stdout or the credential file).
        if (pending.state.status === 'completed') {
          setTimeout(() => { this.pendingOAuth.delete(key); }, 60_000);
          return;
        }

        // Exit 0 after the code was submitted → login almost certainly succeeded;
        // the token lives in the container's credential file, not in stdout.
        // Recover it from the container before declaring failure.
        if (code === 0 && (pending.state.status === 'waiting_callback' || pending.state.status === 'waiting_for_code')) {
          void this.finalizeOAuthFromContainer(key, pending).then((ok) => {
            if (!ok) {
              pending.state.status = 'failed';
              pending.state.error =
                'El login finalizó pero no se encontró la credencial en la máquina. ' +
                'Reintenta o usa el Terminal del agente: claude auth login';
            }
            setTimeout(() => { this.pendingOAuth.delete(key); }, 60_000);
          });
          return;
        }

        if (pending.state.status === 'scanning_url' || pending.state.status === 'waiting_callback') {
          const snippet = pending.fullBuf.replace(/\s+/g, ' ').slice(-300);
          const msg = code === 127
            ? 'Comando `claude` no encontrado. Reconstruye la imagen del agente con `./docker/agents/build.sh`.'
            : `claude auth login finalizó inesperadamente (código ${code}).\nÚltima salida: ${snippet}`;
          if (pending.state.status === 'scanning_url') {
            pending.onError?.(msg);
            pending.onUrl = null; pending.onError = null;
          }
          pending.state.status = 'failed';
          pending.state.error = msg;
        }
        setTimeout(() => { this.pendingOAuth.delete(key); }, 60_000);
      });

      // Timeout: 30 s is enough for the URL to appear.
      setTimeout(() => {
        if (pending.state.status === 'scanning_url') {
          const snippet = pending.fullBuf.replace(/\s+/g, ' ').slice(-400);
          this.logger.warn(`[oauth:${key}] timeout. fullBuf tail: ${snippet}`);
          pending.onError?.(
            `La CLI de Claude Code no devolvió una URL capturada.\n` +
            `Usa la pestaña Terminal del agente → ejecuta: claude auth login\n` +
            (snippet ? `Salida recibida: ${snippet}` : 'No se recibió ninguna salida.'),
          );
          pending.onUrl = null; pending.onError = null;
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
          pending.state.status = 'failed';
          pending.state.error = 'Timeout esperando URL';
          this.pendingOAuth.delete(key);
        }
      }, 30_000);
    });
  }

  /**
   * Submit the authorization code obtained after visiting the OAuth URL.
   * Writes the code to the running `claude auth login` process's stdin so it
   * can exchange it for a token.
   */
  submitOAuthCode(key: string, code: string): boolean {
    const pending = this.pendingOAuth.get(key);
    if (!pending) return false;
    if (pending.state.status === 'waiting_callback' || pending.state.status === 'completed') return true;
    if (pending.state.status !== 'waiting_for_code') return false;
    pending.state.status = 'waiting_callback';
    try {
      pending.proc.stdin?.write(code.trim() + '\n');
      this.logger.log(`[oauth:${key}] code submitted (${code.length} chars)`);
      return true;
    } catch (e) {
      this.logger.warn(`[oauth:${key}] failed to write code to stdin: ${(e as Error).message}`);
      return false;
    }
  }

  private handleOAuthToken(key: string, pending: PendingOAuth, token: string): void {
    if (pending.state.status === 'completed') return; // already done
    pending.state.status = 'completed';
    pending.state.configured = true;
    void this.saveCredential(pending.orgId, 'oauth', token).then(() => {
      this.logger.log(`[oauth:${key}] token guardado para org ${pending.orgId}`);
    }).catch((e) => {
      this.logger.warn(`[oauth:${key}] error guardando token: ${(e as Error).message}`);
      pending.state.error = 'Token recibido pero no se pudo guardar: ' + (e as Error).message;
      pending.state.configured = false;
    });
  }

  /**
   * After `claude auth login` reports success, the OAuth token is written to the
   * container's credential file (`~/.claude/.credentials.json` or the
   * `@anthropic-ai/claude-code` path) — it is never printed to stdout. Read the
   * file back, extract the token, and persist it to org_integrations.
   * Returns true if a token was found and saved.
   */
  private async finalizeOAuthFromContainer(key: string, pending: PendingOAuth): Promise<boolean> {
    if (pending.state.status === 'completed') return true;
    const token = await this.readOAuthTokenFromContainer(pending.containerName);
    if (token) {
      this.logger.log(`[oauth:${key}] token recuperado de la credencial del contenedor`);
      this.handleOAuthToken(key, pending, token);
      return true;
    }

    // Newer Claude Code versions may keep the OAuth token behind their own
    // credential storage. The CLI status is the source of truth in that case.
    if (await this.checkContainerAuthStatus(pending.containerName)) {
      pending.state.status = 'completed';
      pending.state.configured = true;
      pending.state.error = null;
      const container = this.containers.get(key);
      if (container) container.hasToken = true;
      this.logger.log(`[oauth:${key}] login confirmado por claude auth status`);
      return true;
    }

    this.logger.warn(`[oauth:${key}] login terminó sin auth utilizable en ${pending.containerName}`);
    return false;
  }

  /**
   * Read the Claude Code credential file(s) inside a container and extract the
   * OAuth access token. Retries 3 times with 1 s gap in case the file is
   * written just after the process exits.
   *
   * Handles all known credential shapes:
   *  • `{ claudeAiOauth: { accessToken } }` — written by `claude auth login`
   *  • `{ access_token }` / `{ accessToken }` / `{ token }` — our own injected format
   *  • Raw sk-ant-… token in the file text (legacy)
   *
   * NOTE: OAuth tokens from `claude auth login` are NOT necessarily `sk-ant-…`
   * prefixed — they can be JWTs or other bearer tokens. We accept any string
   * that is at least 20 chars and is the value of a recognized key.
   */
  private async readOAuthTokenFromContainer(containerName: string): Promise<string | null> {
    // The credential may be written just after the process exits — retry briefly.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 1200));
      try {
        // Check every known location; use $HOME so it works regardless of user.
        const { stdout } = await execFileAsync('docker', [
          'exec', containerName, 'sh', '-c',
          // Emit each file's content prefixed with a sentinel so we can split them.
          'for f in ' +
            '"$HOME/.claude/.credentials.json" ' +
            '"$HOME/.config/@anthropic-ai/claude-code/.credentials.json" ' +
            '"/root/.claude/.credentials.json" ' +
            '"/root/.config/@anthropic-ai/claude-code/.credentials.json"; ' +
          'do [ -f "$f" ] && printf "===FILE===\\n" && cat "$f" && printf "\\n===END===\\n"; done',
        ], { timeout: 12_000, env: process.env });

        const blocks = stdout.split('===FILE===').slice(1);
        for (const block of blocks) {
          const text = block.split('===END===')[0].trim();
          if (!text) continue;
          try {
            const json = JSON.parse(text) as Record<string, unknown>;
            const candidate =
              // Shape written by `claude auth login` (nested OAuth object)
              (json?.claudeAiOauth as Record<string, unknown>)?.accessToken ??
              (json?.claudeAiOauth as Record<string, unknown>)?.refreshToken ??
              // Flat shapes (our injected format + older CLI versions)
              json?.access_token ??
              json?.accessToken ??
              json?.token ??
              json?.api_key;
            if (typeof candidate === 'string' && candidate.length >= 20) {
              this.logger.log(`[oauth] token extraído de credencial del contenedor (longitud ${candidate.length})`);
              return candidate;
            }
          } catch {
            /* JSON parse failed — fall through to regex */
          }
          // Last resort: any sk-ant token in the raw text
          const m = /sk-ant-[A-Za-z0-9_-]{20,}/.exec(text);
          if (m) return m[0];
        }

        if (stdout.includes('===FILE===')) {
          this.logger.warn(`[oauth] archivos de credenciales encontrados pero sin token exportable`);
        }
      } catch (e) {
        this.logger.warn(`[oauth] intento ${attempt + 1}: error leyendo credencial de ${containerName}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    return null;
  }

  private async checkContainerAuthStatus(containerName: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('docker', [
        'exec', containerName, 'claude', 'auth', 'status', '--json',
      ], { timeout: 15_000, env: process.env });
      const parsed = JSON.parse(stdout) as { loggedIn?: boolean; authenticated?: boolean };
      return parsed.loggedIn === true || parsed.authenticated === true;
    } catch {
      return false;
    }
  }

  private async hasMachineAuth(key: string): Promise<boolean> {
    const container = this.containers.get(key);
    if (!container) return false;
    if (container.hasToken) return true;
    const authenticated =
      await this.checkContainerAuthStatus(container.name) ||
      await this.checkContainerHasAuth(container.name);
    if (authenticated) container.hasToken = true;
    return authenticated;
  }

  /** Returns the current state of an in-flight or recently-completed OAuth flow. */
  pollOAuthResult(key: string): OAuthFlowState | null {
    const p = this.pendingOAuth.get(key);
    return p ? { ...p.state } : null;
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

  /**
   * Check whether a running container already has Claude credentials — either
   * via the env var injected at creation time, or via a credentials file written
   * by `claude auth login` run manually in the terminal.
   * This does NOT probe the API; it's a fast local check.
   */
  async checkContainerHasAuth(containerName: string): Promise<boolean> {
    if (await this.checkContainerAuthStatus(containerName)) return true;
    try {
      const { stdout } = await execFileAsync('docker', [
        'exec', containerName, 'sh', '-c',
        // Check all known credential locations without making network calls.
        'printf "%s" "${CLAUDE_CODE_OAUTH_TOKEN:+ENV}${ANTHROPIC_API_KEY:+ENV}"; ' +
        'test -f ~/.config/@anthropic-ai/claude-code/.credentials.json && printf FILE; ' +
        'test -f ~/.claude/.credentials.json && printf FILE2',
      ], { timeout: 8_000, env: process.env });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Inject the org credential into a running container by writing it to the
   * Claude credentials file. Used when reconnecting to a container that was
   * created without a credential (or whose env var was lost after a host restart).
   */
  private async injectCredentialIntoContainer(containerName: string, credential: StoredClaudeCredential): Promise<void> {
    const envVar = this.envVarFor(credential.method);
    try {
      // Write to both known credential paths for broad compatibility.
      const credJson = JSON.stringify(
        credential.method === 'api_key'
          ? { type: 'api_key', api_key: credential.token }
          : { type: 'oauth', access_token: credential.token, token_type: 'Bearer' }
      );
      await execFileAsync('docker', [
        'exec', containerName, 'sh', '-c',
        [
          'mkdir -p ~/.config/@anthropic-ai/claude-code',
          `printf '%s' '${credJson.replace(/'/g, "'\\''")}'  > ~/.config/@anthropic-ai/claude-code/.credentials.json`,
          'mkdir -p ~/.claude',
          `printf '%s' '${credJson.replace(/'/g, "'\\''")}'  > ~/.claude/.credentials.json`,
        ].join(' && '),
      ], { timeout: 10_000, env: process.env });
      this.logger.log(`[cred] Injected ${envVar} into container ${containerName}`);
    } catch (e) {
      this.logger.warn(`[cred] Failed to inject credential into ${containerName}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  /**
   * Verify the credential works inside an already-booted machine (by key).
   * Checks ACTUAL container auth state rather than the creation-time `hasToken`
   * flag, so it correctly detects manual `claude auth login` sessions.
   */
  async verifyAuth(orgId: string, key: string): Promise<AuthCheckResult> {
    const c = this.containers.get(key);
    if (!c) return { ok: false, error: 'NO_MACHINE' };

    // A manual `claude auth login` is already authoritative. Returning here is
    // important: the previous implementation followed this with a model probe,
    // so a timeout/quota/network error made a valid terminal login look invalid.
    if (await this.checkContainerAuthStatus(c.name)) {
      c.hasToken = true;
      return { ok: true };
    }

    // If the container says hasToken=false, check the actual state — the user
    // may have authenticated manually via `claude auth login` in the terminal.
    const hasAuth = c.hasToken || await this.checkContainerHasAuth(c.name);
    if (!hasAuth) {
      // No auth found in container — try to inject from org credential if available.
      const credential = await this.resolveCredential(orgId);
      if (credential) {
        await this.injectCredentialIntoContainer(c.name, credential);
        c.hasToken = true;
      } else {
        return { ok: false, authFailed: true, error: 'NO_TOKEN: la máquina no tiene credencial. Usa el Terminal para ejecutar `claude auth login`.' };
      }
    } else if (!c.hasToken) {
      c.hasToken = true; // update flag to reflect reality
    }

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
      // Container is live (either original boot or recovered by onModuleInit).
      // Ensure the credential is present — it may not have been injected if the
      // container was reconnected from a bare Docker scan at startup.
      if (!existing.hasToken) {
        const cred = await this.resolveCredential(opts.orgId);
        if (cred) {
          await this.injectCredentialIntoContainer(existing.name, cred);
          existing.hasToken = true;
          emit('ready', `Máquina ya activa (${existing.image}) — credencial re-inyectada`);
        } else {
          emit('ready', `Máquina ya activa (${existing.image}) — sin credencial configurada`);
        }
      } else {
        emit('ready', `Máquina ya activa (${existing.image})`);
      }
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

    const key = opts.machineKey ?? opts.taskId;
    const sessionScoped = Boolean(opts.machineKey);
    const credential = await this.resolveCredential(opts.orgId);
    const hasLocalMachineAuth = Boolean(opts.machineKey) && await this.hasMachineAuth(key);
    if (!credential && !hasLocalMachineAuth) {
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
    let container = this.containers.get(key);
    // A session machine booted before the credential existed has no token — the
    // claude CLI can't authenticate. Recreate it now that we have a credential.
    if (container && !container.hasToken && credential) {
      await this.destroyContainer(key);
      container = undefined;
    }
    if (!container) {
      if (!credential) {
        return { ok: false, text: '', error: 'NO_MACHINE_AUTH: la máquina autenticada ya no está disponible' };
      }
      container = (await this.createContainer({ key, image, role, sessionScoped, credential })) ?? undefined;
    }
    if (!container) {
      return { ok: false, text: '', error: 'No se pudo crear el contenedor de Claude Code' };
    }

    // Re-inject credential via docker exec -e so the token is always present,
    // even when connecting to a container that was created before the credential
    // existed, or after a Docker Engine / process restart.
    const execEnv: NodeJS.ProcessEnv = { ...process.env };
    const execEnvArgs: string[] = [];
    if (credential) {
      const envVar = this.envVarFor(credential.method);
      execEnv[envVar] = credential.token;
      execEnvArgs.push('-e', envVar); // pass-through from childEnv, not from argv
    }

    const execArgs = [
      'exec',
      '-w', '/work',
      ...execEnvArgs,
      container.name,
      'claude',
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--max-turns', String(opts.maxTurns ?? DEFAULT_MAX_TURNS),
    ];

    const result = await this.spawnAndStream(execArgs, execEnv, opts);
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

  // ── Git operations (real repo per agent) ─────────────────────────────────────

  /**
   * Clone/refresh the session repo inside the agent's machine and check out the
   * agent's branch — continuing it if it already exists on origin, else forking
   * from the integration branch. The token is embedded in the origin remote so
   * push works; it lives only inside this isolated, network-segmented container
   * (destroyed at session end) and is redacted from any surfaced output.
   */
  async setupAgentRepo(opts: SetupAgentRepoOptions): Promise<GitOpResult> {
    if (!(await this.dockerAvailable())) return { ok: false, error: 'Docker no disponible en este nodo' };
    const container = await this.getOrCreateContainerForKey(opts.machineKey, opts.orgId, opts.role);
    if (!container) return { ok: false, error: 'NO_MACHINE: no se pudo preparar la máquina del agente' };

    const name = container.name;
    const token = opts.token;
    const remote = GithubService.tokenizedRemote(opts.repoUrl, token);

    // Trust the mounted /work regardless of the container uid.
    await this.gitExec(name, ['config', '--global', '--add', 'safe.directory', '/work'], token);

    const isRepo = (await this.gitExec(name, ['rev-parse', '--is-inside-work-tree'], token)).ok;
    if (!isRepo) {
      const init = await this.gitExec(name, ['init'], token);
      if (!init.ok) return { ok: false, error: `git init: ${init.error}` };
      await this.gitExec(name, ['remote', 'add', 'origin', remote], token);
    } else {
      await this.gitExec(name, ['remote', 'set-url', 'origin', remote], token);
    }

    await this.gitExec(name, ['config', 'user.name', opts.identity.name], token);
    await this.gitExec(name, ['config', 'user.email', opts.identity.email], token);

    const fetched = await this.gitExec(
      name,
      ['fetch', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
      token,
    );
    if (!fetched.ok) return { ok: false, error: `git fetch: ${fetched.error}` };

    // Continue the agent's branch if it already exists on origin, else fork develop.
    const hasBranch = (await this.gitExec(name, ['rev-parse', '--verify', `origin/${opts.branch}`], token)).ok;
    const startPoint = hasBranch ? `origin/${opts.branch}` : `origin/${opts.baseBranch}`;
    const checkout = await this.gitExec(name, ['checkout', '-B', opts.branch, startPoint], token);
    if (!checkout.ok) return { ok: false, error: `git checkout (${startPoint}): ${checkout.error}` };

    return { ok: true };
  }

  /**
   * Stage, commit (as the agent identity) and push the agent's branch. Returns
   * pushed=false with error='NO_CHANGES' when the agent produced no file changes.
   */
  async commitAndPushAgentRepo(opts: CommitPushOptions): Promise<CommitPushResult> {
    const container = this.containers.get(opts.machineKey);
    if (!container) return { ok: false, pushed: false, error: 'NO_MACHINE' };
    const name = container.name;
    const token = opts.token;

    await this.gitExec(name, ['add', '-A'], token);
    const status = await this.gitExec(name, ['status', '--porcelain'], token);
    if (status.ok && status.stdout.trim() === '') {
      const sha = (await this.gitExec(name, ['rev-parse', 'HEAD'], token)).stdout.trim();
      return { ok: true, pushed: false, headSha: sha || undefined, error: 'NO_CHANGES' };
    }

    const commit = await this.gitExec(
      name,
      ['commit', '-m', opts.message, '--author', `${opts.identity.name} <${opts.identity.email}>`],
      token,
    );
    if (!commit.ok) return { ok: false, pushed: false, error: `git commit: ${commit.error}` };

    const push = await this.gitExec(name, ['push', '-u', 'origin', opts.branch], token);
    if (!push.ok) return { ok: false, pushed: false, error: `git push: ${push.error}` };

    const headSha = (await this.gitExec(name, ['rev-parse', 'HEAD'], token)).stdout.trim();
    return { ok: true, pushed: true, headSha: headSha || undefined };
  }

  private async getOrCreateContainerForKey(
    key: string,
    orgId: string,
    role: string,
  ): Promise<ClaudeContainer | null> {
    const existing = this.containers.get(key);
    if (existing) return existing;
    const image = await this.resolveImage(role);
    if (!image) return null;
    const credential = await this.resolveCredential(orgId);
    return (await this.createContainer({ key, image, role, sessionScoped: true, credential })) ?? null;
  }

  /** Run `git <args>` inside the container's /work; redact the token from any error output. */
  private async gitExec(
    containerName: string,
    args: string[],
    token?: string,
  ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        'docker',
        ['exec', '-w', '/work', containerName, 'git', ...args],
        { timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env: process.env },
      );
      return { ok: true, stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const raw = (e.stderr || e.message || '').toString();
      return { ok: false, stdout: e.stdout ?? '', stderr: raw, error: this.redactToken(raw, token) };
    }
  }

  /** Strip the embedded PAT from any git output before it is logged or surfaced. */
  private redactToken(text: string, token?: string): string {
    let out = text ?? '';
    if (token) out = out.split(token).join('***');
    return out.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
  }

  /**
   * Create a long-lived named container with the role's image + optional token.
   *
   * Uses a DETERMINISTIC name (`eva-agent-{key32}`) so we can always reconnect
   * to the same container after a process restart, without scanning Docker or
   * storing the container name in the DB.
   *
   * If a container with that name already exists:
   *  - Running → reconnect (register in map, inject credential if needed).
   *  - Stopped → `docker start` then reconnect.
   *  - Otherwise → create a fresh container.
   */
  private async createContainer(input: {
    key: string;
    image: string;
    role?: string;
    sessionScoped: boolean;
    credential: StoredClaudeCredential | null;
  }): Promise<ClaudeContainer | null> {
    const { key, image, role, sessionScoped, credential } = input;

    // 1. Already tracked in-memory — return immediately.
    const existing = this.containers.get(key);
    if (existing) {
      if (existing.reapTimer) { clearTimeout(existing.reapTimer); existing.reapTimer = undefined; }
      return existing;
    }

    // 2. Deterministic name so we can reconnect across restarts.
    const name = this.deterministicContainerName(key);

    // 3. Check Docker for an existing container with this name.
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect', '--format', '{{.State.Running}}\t{{.Config.Image}}', name,
      ], { timeout: 8_000, env: process.env });
      const [running, existingImage] = stdout.trim().split('\t');

      if (running === 'false') {
        // Container exists but stopped — restart it.
        this.logger.log(`[boot] Restarting stopped container ${name}`);
        await execFileAsync('docker', ['start', name], { timeout: 30_000, env: process.env });
      }

      if (running === 'true' || running === 'false') {
        // Container is now running — register it.
        const container: ClaudeContainer = {
          name,
          hostDir: '',   // tmpdir is gone after restart; /work is still mounted inside
          image: existingImage?.trim() || image,
          role,
          hasToken: Boolean(credential), // will be verified/updated by verifyAuth
          sessionScoped,
          shells: new Map(),
        };
        this.containers.set(key, container);
        this.logger.log(`[boot] Reconnected to existing container ${name} (key ${key.slice(0, 8)})`);

        // Re-inject credential into the container (covers the case where the
        // container was created before a credential existed, or if the env var
        // is lost after a Docker Engine restart).
        if (credential) {
          await this.injectCredentialIntoContainer(name, credential);
          container.hasToken = true;
        }
        return container;
      }
    } catch {
      // inspect failed → container doesn't exist, fall through to create.
    }

    // 4. Create a fresh container.
    const spec = machineSpecForRole(role ?? 'backend');
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

    // Also write credentials file so auth survives Docker Engine restarts
    // (env vars DO persist, but this is a belt-and-suspenders guard).
    if (credential) {
      await this.injectCredentialIntoContainer(name, credential).catch(() => undefined);
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
    // hostDir may be empty when the container was reconnected after a restart.
    if (container.hostDir) {
      await rm(container.hostDir, { recursive: true, force: true }).catch(() => undefined);
    }
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
