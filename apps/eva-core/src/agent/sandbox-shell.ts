import { randomBytes } from 'node:crypto';

/**
 * Minimal duplex contract for the process backing a {@link PersistentShell}.
 * In production this wraps a `docker exec -i` child process; in tests it's a
 * fake so the whole multi-phase read/dialog logic runs without Docker.
 */
export interface ShellProcess {
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  kill(): void;
  readonly exited: boolean;
  onExit(cb: () => void): void;
}

export type ShellRunStatus = 'completed' | 'running' | 'awaiting_input' | 'error';

export interface ShellTimeouts {
  /** Wait for the first byte of output before handing control back. */
  firstOutputMs: number;
  /** Idle gap after some output → assume still running, return partial. */
  betweenOutputMs: number;
  /** Hard cap on a single foreground read. */
  maxExecMs: number;
  /** Idle gap to check whether the tail looks like a prompt waiting for input. */
  dialogIdleMs: number;
}

export interface ShellRunResult {
  output: string;
  status: ShellRunStatus;
  /** Present only when status==='completed'. */
  exitCode?: number;
}

export const DEFAULT_SHELL_TIMEOUTS: ShellTimeouts = {
  firstOutputMs: 30_000,
  betweenOutputMs: 15_000,
  maxExecMs: 120_000,
  dialogIdleMs: 4_000,
};

/** Dialog patterns (case-insensitive) — tail matches → hand control back for input. */
const DIALOG_PATTERNS: RegExp[] = [
  /y\/n/i,
  /yes\/no/i,
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /password\s*:?\s*$/i,
  /passphrase/i,
  /press\s+enter/i,
  /continue\?\s*$/i,
  /proceed\?\s*$/i,
  /overwrite\?\s*$/i,
  /\?\s*$/,
  /:\s*$/,
];

const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1B\][^\x07]*(?:\x07|\x1B\\)/g;
const POLL_MS = 120;
const OUTPUT_CAP = 16_000;

/**
 * A long-lived shell inside the per-task sandbox container.
 *
 * Mirrors Agent Zero's `LocalInteractiveSession` (plugins/_code_execution):
 * one shell process stays alive across steps, so env vars, `cd`, activated
 * venvs and running foreground programs persist — unlike a fresh `docker exec`
 * per step. The shell's prompt is rewritten to a unique sentinel embedding the
 * last exit code (`PS1='\n<MARKER>:$?\n'`), so:
 *   - the marker reappears only when the shell regains control → command done;
 *   - a program blocked on stdin never emits the marker → we detect "running"
 *     or "awaiting_input" and hand control back, and the model resumes it via
 *     {@link sendInput}.
 */
export class PersistentShell {
  private buffer = '';
  private booted = false;
  private readonly id = randomBytes(4).toString('hex');
  private readonly marker: string;
  private readonly markerRe: RegExp;
  /** True while a command was sent and its completion marker hasn't returned. */
  private busy = false;

  constructor(private readonly proc: ShellProcess) {
    this.marker = `__EVA_END_${this.id}__`;
    this.markerRe = new RegExp(`${this.marker}:(-?\\d+)`);
    this.proc.onData((chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > OUTPUT_CAP * 4) {
        this.buffer = this.buffer.slice(-OUTPUT_CAP * 2);
      }
    });
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get exited(): boolean {
    return this.proc.exited;
  }

  /**
   * Configure the prompt sentinel and a quiet, line-buffered environment, then
   * drain the boot banner. Safe to call repeatedly (no-op after the first time).
   */
  async init(): Promise<void> {
    if (this.booted) return;
    // bash interprets \n in PS1; $? is re-expanded at every prompt.
    const boot = [
      'stty -echo 2>/dev/null',
      `export PS1='\\n${this.marker}:'\\$'?''\\n'`,
      "export PS2=''",
      "export PROMPT_COMMAND=''",
      'export PYTHONUNBUFFERED=1',
      'export PAGER=cat GIT_PAGER=cat',
      'cd /work 2>/dev/null',
      '',
    ].join('\n');
    this.buffer = '';
    this.proc.write(boot);
    // Wait for the first marker so the baseline is a clean prompt.
    await this.drainUntilMarkerOrIdle(3_000);
    this.buffer = '';
    this.booted = true;
  }

  /**
   * Send a command line and read its output with multi-phase timeouts.
   * The command should be a single logical line (callers run multi-line code
   * from a file, e.g. `python /work/step.py`).
   */
  async run(command: string, timeouts: ShellTimeouts): Promise<ShellRunResult> {
    if (this.proc.exited) return { output: '', status: 'error' };
    await this.init();
    this.buffer = '';
    this.busy = true;
    this.proc.write(command.replace(/\r?\n$/, '') + '\n');
    return this.readLoop(timeouts);
  }

  /**
   * Feed keystrokes to a command that is waiting on stdin, then resume reading.
   * Mirrors Agent Zero's `input` tool.
   */
  async sendInput(keyboard: string, timeouts: ShellTimeouts): Promise<ShellRunResult> {
    if (this.proc.exited) return { output: '', status: 'error' };
    this.buffer = '';
    this.busy = true;
    this.proc.write(keyboard.replace(/\r?\n$/, '') + '\n');
    return this.readLoop(timeouts);
  }

  /** Resume reading a still-running command without sending anything new. */
  async read(timeouts: ShellTimeouts): Promise<ShellRunResult> {
    if (this.proc.exited) return { output: '', status: 'error' };
    if (!this.busy) {
      // Nothing pending — return whatever is buffered.
      const out = this.cleanup(this.takeBuffer());
      return { output: out, status: 'completed', exitCode: 0 };
    }
    return this.readLoop(timeouts);
  }

  close(): void {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Drain output during boot until the first prompt marker shows up or it goes idle. */
  private async drainUntilMarkerOrIdle(totalMs: number): Promise<void> {
    const start = Date.now();
    let lastLen = -1;
    let idleSince = Date.now();
    for (;;) {
      await sleep(POLL_MS);
      const now = Date.now();
      if (this.markerRe.test(this.buffer)) return;
      if (this.buffer.length !== lastLen) {
        lastLen = this.buffer.length;
        idleSince = now;
      } else if (now - idleSince > 600) {
        return; // quiet long enough
      }
      if (now - start > totalMs) return;
    }
  }

  private async readLoop(t: ShellTimeouts): Promise<ShellRunResult> {
    const start = Date.now();
    let lastOutputAt = start;
    let gotOutput = false;
    let seen = '';

    for (;;) {
      await sleep(POLL_MS);
      const now = Date.now();

      if (this.buffer.length > seen.length) {
        seen = this.buffer;
        lastOutputAt = now;
        gotOutput = true;
      }

      // Completion: the prompt marker reappeared.
      const m = this.markerRe.exec(seen);
      if (m) {
        this.busy = false;
        const exitCode = parseInt(m[1], 10);
        const out = this.cleanup(seen.slice(0, m.index));
        this.buffer = '';
        return { output: out, status: 'completed', exitCode };
      }

      // Hard cap.
      if (now - start > t.maxExecMs) {
        return this.partial(seen, 'running');
      }

      if (!gotOutput) {
        if (now - start > t.firstOutputMs) return this.partial(seen, 'running');
        continue;
      }

      // Got some output, then went idle.
      if (now - lastOutputAt > t.dialogIdleMs && this.looksLikeDialog(seen)) {
        return this.partial(seen, 'awaiting_input');
      }
      if (now - lastOutputAt > t.betweenOutputMs) {
        return this.partial(seen, 'running');
      }
    }
  }

  private partial(raw: string, status: ShellRunStatus): ShellRunResult {
    // Keep the buffer so a follow-up read()/sendInput() sees continued output,
    // but advance past what we've already returned.
    const cleaned = this.cleanup(raw);
    return { output: cleaned, status };
  }

  private looksLikeDialog(text: string): boolean {
    const tail = this.cleanup(text)
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .slice(-2);
    return tail.some((line) => DIALOG_PATTERNS.some((p) => p.test(line)));
  }

  private takeBuffer(): string {
    const b = this.buffer;
    this.buffer = '';
    return b;
  }

  /** Strip ANSI/OSC escapes, the prompt marker, and our own boot noise. */
  private cleanup(text: string): string {
    let out = text.replace(OSC_RE, '').replace(ANSI_RE, '');
    // Drop any line carrying the prompt marker (with or without exit code).
    out = out
      .split('\n')
      .filter((line) => !line.includes(this.marker))
      .join('\n');
    // Normalise carriage returns from PTY echoes.
    out = out.replace(/\r(?!\n)/g, '\n').replace(/\r\n/g, '\n');
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    if (out.length > OUTPUT_CAP) out = out.slice(0, OUTPUT_CAP) + '\n…[salida truncada]';
    return out;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
