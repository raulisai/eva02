import { PersistentShell, ShellProcess, ShellTimeouts } from '../sandbox-shell';

/** Controllable fake of the docker-exec process backing a PersistentShell. */
class FakeProc implements ShellProcess {
  writes: string[] = [];
  exited = false;
  private cbs: Array<(s: string) => void> = [];

  write(d: string): void { this.writes.push(d); }
  onData(cb: (s: string) => void): void { this.cbs.push(cb); }
  kill(): void { this.exited = true; }
  onExit(): void { /* unused in tests */ }

  feed(s: string): void { for (const cb of this.cbs) cb(s); }

  /** The unique PS1 sentinel the shell installed during init(). */
  get marker(): string {
    const m = this.writes.join('').match(/__EVA_END_[0-9a-f]+__/);
    return m ? m[0] : '';
  }
  /** Writes after the boot line (i.e. actual commands / keystrokes). */
  get commandWrites(): string[] {
    return this.writes.filter((w) => !w.includes('PS1=') && w.trim().length > 0);
  }
}

const FAST: ShellTimeouts = {
  firstOutputMs: 1500,
  betweenOutputMs: 500,
  maxExecMs: 4000,
  dialogIdleMs: 250,
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until predicate true (or give up), to coordinate with the shell's loop. */
async function until(fn: () => boolean, tries = 80): Promise<void> {
  for (let i = 0; i < tries && !fn(); i++) await delay(15);
}

/** Satisfy init()'s boot drain by echoing the prompt marker once. */
async function boot(proc: FakeProc): Promise<void> {
  await until(() => !!proc.marker);
  proc.feed(`${proc.marker}:0\n`);
}

describe('PersistentShell', () => {
  it('runs a command and returns output + exit code when the prompt marker returns', async () => {
    const proc = new FakeProc();
    const shell = new PersistentShell(proc);

    const p = shell.run('echo hola', FAST);
    await boot(proc);
    // wait for the command to be written, then feed its output + completion marker
    await until(() => proc.commandWrites.some((w) => w.includes('echo hola')));
    proc.feed(`hola\n${proc.marker}:0\n`);

    const res = await p;
    expect(res.status).toBe('completed');
    expect(res.exitCode).toBe(0);
    expect(res.output).toBe('hola');
  });

  it('reports a non-zero exit code without throwing', async () => {
    const proc = new FakeProc();
    const shell = new PersistentShell(proc);

    const p = shell.run('python bad.py', FAST);
    await boot(proc);
    await until(() => proc.commandWrites.some((w) => w.includes('python bad.py')));
    proc.feed(`Traceback...\nSyntaxError: invalid syntax\n${proc.marker}:1\n`);

    const res = await p;
    expect(res.status).toBe('completed');
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('SyntaxError');
  });

  it('detects a dialog prompt and hands control back as awaiting_input', async () => {
    const proc = new FakeProc();
    const shell = new PersistentShell(proc);

    const p = shell.run('rm -i file', FAST);
    await boot(proc);
    await until(() => proc.commandWrites.some((w) => w.includes('rm -i file')));
    // Emit a prompt that never completes (no marker).
    proc.feed('remove file? [y/n] ');

    const res = await p;
    expect(res.status).toBe('awaiting_input');
    expect(res.output).toContain('remove file?');
  });

  it('resumes a waiting command via sendInput until it completes', async () => {
    const proc = new FakeProc();
    const shell = new PersistentShell(proc);

    const p = shell.run('read x; echo got=$x', FAST);
    await boot(proc);
    await until(() => proc.commandWrites.some((w) => w.includes('read x')));
    proc.feed('? '); // waiting for input
    const first = await p;
    expect(first.status).toBe('awaiting_input');

    const p2 = shell.sendInput('42', FAST);
    await until(() => proc.commandWrites.some((w) => w.trim() === '42'));
    proc.feed(`got=42\n${proc.marker}:0\n`);
    const second = await p2;
    expect(second.status).toBe('completed');
    expect(second.output).toContain('got=42');
  });

  it('reports a still-running command as running when output goes idle with no marker', async () => {
    const proc = new FakeProc();
    const shell = new PersistentShell(proc);

    const p = shell.run('sleep 100 && echo done', FAST);
    await boot(proc);
    await until(() => proc.commandWrites.some((w) => w.includes('sleep 100')));
    proc.feed('starting work...\n'); // output, then silence (no dialog, no marker)

    const res = await p;
    expect(res.status).toBe('running');
    expect(res.output).toContain('starting work');
  });

  it('strips ANSI escapes and the prompt marker from output', async () => {
    const proc = new FakeProc();
    const shell = new PersistentShell(proc);

    const p = shell.run('ls --color', FAST);
    await boot(proc);
    await until(() => proc.commandWrites.some((w) => w.includes('ls --color')));
    proc.feed(`\x1B[0;32mfile.txt\x1B[0m\n${proc.marker}:0\n`);

    const res = await p;
    expect(res.output).toBe('file.txt');
    expect(res.output).not.toContain('__EVA_END_');
    expect(res.output).not.toContain('\x1B');
  });
});
