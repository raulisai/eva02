import { SandboxService } from '../sandbox.service';
import { IntegrationsService } from '../../integrations/integrations.service';
import { ShellProcess } from '../sandbox-shell';

type DockerCall = { args: string[] };

/**
 * Deterministic fake of the per-container shell process. Echoes the prompt
 * marker on boot and, for each command, emits the configured output followed by
 * the marker + exit code — so the persistent-shell path runs without Docker.
 */
class FakeShellProc implements ShellProcess {
  exited = false;
  writes: string[] = [];
  private cbs: Array<(s: string) => void> = [];

  constructor(private readonly outputFor: () => { output: string; exit: number }) {}

  write(d: string): void {
    this.writes.push(d);
    const marker = (this.writes.join('').match(/__EVA_END_[0-9a-f]+__/) ?? [''])[0];
    if (!marker) return;
    if (d.includes('PS1=')) { setImmediate(() => this.emit(`${marker}:0\n`)); return; }
    if (d.trim()) {
      const { output, exit } = this.outputFor();
      setImmediate(() => this.emit(`${output}\n${marker}:${exit}\n`));
    }
  }
  private emit(s: string): void { for (const cb of this.cbs) cb(s); }
  onData(cb: (s: string) => void): void { this.cbs.push(cb); }
  kill(): void { this.exited = true; }
  onExit(): void { /* unused */ }
}

describe('SandboxService', () => {
  let service: SandboxService;
  let dockerCalls: DockerCall[];
  let dockerSpy: jest.SpyInstance;
  let integrations: { getSecret: jest.Mock; list: jest.Mock };
  let shellProcs: FakeShellProc[];
  let shellOutput: { output: string; exit: number };

  beforeEach(() => {
    integrations = {
      getSecret: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
    };
    service = new SandboxService(integrations as unknown as IntegrationsService);
    jest.spyOn(service, 'dockerAvailable').mockResolvedValue(true);

    // Persistent-shell seam → deterministic fake (no real `docker exec`).
    shellProcs = [];
    shellOutput = { output: 'salida shell', exit: 0 };
    jest
      .spyOn(service as unknown as { createShellProcess: (c: string) => ShellProcess }, 'createShellProcess')
      .mockImplementation(() => {
        const p = new FakeShellProc(() => shellOutput);
        shellProcs.push(p);
        return p;
      });

    dockerCalls = [];
    dockerSpy = jest
      .spyOn(service as unknown as { runDocker: (args: string[], o: unknown) => Promise<{ stdout: string; stderr: string }> }, 'runDocker')
      .mockImplementation(async (args: string[]) => {
        dockerCalls.push({ args });
        // 'image inspect' del eva-sandbox: no existe en el entorno de test
        if (args[0] === 'image') throw new Error('no such image');
        return { stdout: 'salida ok', stderr: '' };
      });
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  // ── one-shot ───────────────────────────────────────────────────────────────

  it('runs one-shot python without network, read-only, in alpine fallback', async () => {
    const result = await service.runOneShot({ language: 'python', code: 'print(1)' });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('salida ok');
    const run = dockerCalls.find((c) => c.args[0] === 'run');
    expect(run).toBeDefined();
    expect(run!.args).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', 'python:3.12-alpine']));
  });

  it('uses bridge network only when explicitly requested (approved exec)', async () => {
    await service.runOneShot({ language: 'bash', code: 'curl example.com', network: true });

    const run = dockerCalls.find((c) => c.args[0] === 'run');
    expect(run!.args).toEqual(expect.arrayContaining(['--network', 'bridge']));
  });

  it('reports docker-unavailable instead of throwing', async () => {
    (service.dockerAvailable as jest.Mock).mockResolvedValue(false);

    const result = await service.runOneShot({ language: 'python', code: 'print(1)' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Docker no disponible');
  });

  // ── secrets ────────────────────────────────────────────────────────────────

  it('substitutes §§secret(provider) before execution and masks the value in output', async () => {
    integrations.getSecret.mockResolvedValue('sk-live-12345');
    dockerSpy.mockImplementation(async (args: string[]) => {
      dockerCalls.push({ args });
      if (args[0] === 'image') throw new Error('no such image');
      return { stdout: 'usando sk-live-12345 para llamar', stderr: '' };
    });

    const result = await service.runOneShot({
      language: 'python',
      code: 'key = "§§secret(stripe)"',
      orgId: 'org-1',
    });

    expect(integrations.getSecret).toHaveBeenCalledWith('org-1', 'credential', 'stripe');
    // El valor jamás vuelve al modelo: la salida lo enmascara con el alias.
    expect(result.output).toContain('§§secret(stripe)');
    expect(result.output).not.toContain('sk-live-12345');
  });

  it('fails clearly when a referenced secret does not exist', async () => {
    integrations.getSecret.mockResolvedValue(null);

    const result = await service.runOneShot({
      language: 'python',
      code: 'k = "§§secret(noexiste)"',
      orgId: 'org-1',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('noexiste');
    // Nada se ejecutó
    expect(dockerCalls.find((c) => c.args[0] === 'run')).toBeUndefined();
  });

  // ── sesión persistente ─────────────────────────────────────────────────────

  it('creates the session container once and reuses one live shell across steps', async () => {
    const r1 = await service.execInSession('task-1', { kind: 'python', code: 'print(1)' });
    const r2 = await service.execInSession('task-1', { kind: 'python', code: 'print(2)' });

    // Solo contamos contenedores de sesión de tarea (no el standby que se replica en background).
    const creates = dockerCalls.filter((c) => c.args[0] === 'run' && c.args.includes('-d') && !c.args.includes('eva-standby'));
    expect(creates).toHaveLength(1);
    expect(creates[0].args).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', 'tail']));
    // Un único shell persistente (no uno por paso) — el estado vive entre pasos.
    expect(shellProcs).toHaveLength(1);
    expect(r1.status).toBe('completed');
    expect(r2.status).toBe('completed');
    expect(service.hasSession('task-1')).toBe(true);
  });


  it('falls back to one-shot execution when the session container cannot be created', async () => {
    dockerSpy.mockImplementation(async (args: string[]) => {
      dockerCalls.push({ args });
      if (args[0] === 'image') throw new Error('no such image');
      // La creación de sesión (run -d) falla; el run one-shot (--rm sin -d) funciona.
      if (args[0] === 'run' && args.includes('-d')) throw new Error('cannot create container');
      return { stdout: 'salida one-shot', stderr: '' };
    });

    const result = await service.execInSession('task-x', { kind: 'python', code: 'print(1)' });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('salida one-shot');
    expect(result.output).toContain('sin sesión persistente');
    expect(service.hasSession('task-x')).toBe(false);
    // Hubo un run one-shot real además del intento de sesión fallido.
    const oneShot = dockerCalls.find((c) => c.args[0] === 'run' && !c.args.includes('-d'));
    expect(oneShot).toBeDefined();
  });

  it('maps terminal kind to bash in the one-shot fallback', async () => {
    dockerSpy.mockImplementation(async (args: string[]) => {
      dockerCalls.push({ args });
      if (args[0] === 'image') throw new Error('no such image');
      if (args[0] === 'run' && args.includes('-d')) throw new Error('cannot create container');
      return { stdout: 'ok', stderr: '' };
    });

    const result = await service.execInSession('task-y', { kind: 'terminal', code: 'ls' });

    expect(result.ok).toBe(true);
    const oneShot = dockerCalls.find((c) => c.args[0] === 'run' && !c.args.includes('-d'));
    expect(oneShot!.args).toEqual(expect.arrayContaining(['alpine:3.20']));
  });

  it('runs terminal commands in the live persistent shell', async () => {
    const result = await service.execInSession('task-1', { kind: 'terminal', code: 'ls -la' });

    expect(result.status).toBe('completed');
    expect(shellProcs).toHaveLength(1);
    expect(shellProcs[0].writes.some((w) => w.includes('ls -la'))).toBe(true);
    // El comando NO va por `docker exec` por paso.
    expect(dockerCalls.find((c) => c.args[0] === 'exec')).toBeUndefined();
  });

  it('forwards keystrokes to a waiting command via sendShellInput', async () => {
    await service.execInSession('task-1', { kind: 'terminal', code: 'rm -i file' });
    const res = await service.sendShellInput('task-1', { keyboard: 'y' });

    expect(res.ok).toBe(true);
    expect(shellProcs[0].writes.some((w) => w.trim() === 'y')).toBe(true);
  });

  it('runs python from an absolute /work path so a prior cd does not break it', async () => {
    await service.execInSession('task-1', { kind: 'python', code: 'print(1)' });

    // El comando referencia el archivo por ruta absoluta (/work/...), no relativa,
    // porque el shell vivo conserva su cwd entre pasos (un `cd` previo persiste).
    const pyWrite = shellProcs[0].writes.find((w) => w.includes('.eva-s0-step-'));
    expect(pyWrite).toMatch(/"\/work\/\.eva-s0-step-\d+\.py"/);
    // Y prefiere ipython con fallback a python.
    expect(pyWrite).toContain('command -v ipython');
  });

  it('multiplexes independent shells per session number', async () => {
    await service.execInSession('task-1', { kind: 'terminal', code: 'echo a', session: 0 });
    await service.execInSession('task-1', { kind: 'terminal', code: 'echo b', session: 1 });

    // Dos shells distintos en el mismo contenedor (terminales paralelas).
    expect(shellProcs).toHaveLength(2);
  });

  it('launches background processes detached and reads their log', async () => {
    await service.execInSession('task-1', { kind: 'terminal', code: 'sleep 99', background: true });
    const bg = dockerCalls.find((c) => c.args[0] === 'exec' && c.args[1] === '-d');
    expect(bg).toBeDefined();
    expect(bg!.args.join(' ')).toContain('.eva-bg.log');

    const out = await service.readBackgroundOutput('task-1');
    expect(out.ok).toBe(true);
    const tail = dockerCalls.filter((c) => c.args[0] === 'exec').pop();
    expect(tail!.args.join(' ')).toContain('tail -c');
  });

  it('runs node one-shot sharing the SAME /work volume of the session', async () => {
    await service.execInSession('task-1', { kind: 'terminal', code: 'echo hola > x.txt' });
    await service.execInSession('task-1', { kind: 'node', code: 'console.log(1)' });

    const nodeRun = dockerCalls.find((c) => c.args[0] === 'run' && c.args.includes('node:20-alpine'));
    expect(nodeRun).toBeDefined();
    const sessionCreate = dockerCalls.find((c) => c.args[0] === 'run' && c.args.includes('-d'));
    const volOf = (call: DockerCall) => call.args[call.args.indexOf('-v') + 1];
    expect(volOf(nodeRun!)).toBe(volOf(sessionCreate!));
  });

  it('release removes the container and forgets the session', async () => {
    await service.execInSession('task-1', { kind: 'python', code: 'print(1)' });
    await service.release('task-1');

    const rm = dockerCalls.find((c) => c.args[0] === 'rm');
    expect(rm).toBeDefined();
    expect(rm!.args).toContain('-f');
    expect(service.hasSession('task-1')).toBe(false);
    // Idempotente
    await expect(service.release('task-1')).resolves.toBeUndefined();
  });

  it('surfaces a non-zero exit code and the program output from the live shell', async () => {
    shellOutput = { output: 'Traceback...\nSyntaxError: invalid syntax', exit: 1 };

    const result = await service.execInSession('task-1', { kind: 'python', code: 'print(' });

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('SyntaxError');
    expect(result.output).toContain('[exit code: 1]');
  });

  // ── warm-up status ─────────────────────────────────────────────────────────

  it('warmUp returns true and sets status=ready when Docker and enriched image are available', async () => {
    // dockerAvailable is already mocked to true; make enriched image available
    dockerSpy.mockImplementation(async (args: string[]) => {
      dockerCalls.push({ args });
      // image inspect succeeds → enriched image exists
      return { stdout: 'sha256:abc', stderr: '' };
    });

    const result = await service.warmUp();

    expect(result).toBe(true);
    expect(service.warmUpStatus).toBe('ready');
  });

  it('warmUp returns true and sets status=no_enriched_image when Docker is up but image missing', async () => {
    // dockerAvailable is already mocked to true; image inspect fails
    dockerSpy.mockImplementation(async (args: string[]) => {
      dockerCalls.push({ args });
      if (args[0] === 'image') throw new Error('no such image');
      return { stdout: '', stderr: '' };
    });

    const result = await service.warmUp();

    expect(result).toBe(true);
    expect(service.warmUpStatus).toBe('no_enriched_image');
  });

  it('warmUp returns false when Docker is unavailable', async () => {
    (service.dockerAvailable as jest.Mock).mockResolvedValue(false);

    const result = await service.warmUp();

    expect(result).toBe(false);
    expect(service.warmUpStatus).toBe('pending');
  });

  it('warmUpWithRetry resolves immediately when Docker is available on first attempt', async () => {
    dockerSpy.mockResolvedValue({ stdout: 'sha256:abc', stderr: '' });

    await service.warmUpWithRetry();

    expect(service.warmUpStatus).toBe('ready');
  });

  it('warmUpWithRetry sets status=no_docker after max retries exhausted', async () => {
    // Spy on warmUp to return false always (Docker never available) and skip real timer waits.
    const warmUpSpy = jest.spyOn(service, 'warmUp').mockResolvedValue(false);
    // Override the internal sleep so retries are instant.
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    });

    await service.warmUpWithRetry();

    expect(warmUpSpy).toHaveBeenCalledTimes(20); // WARMUP_MAX_RETRIES
    expect(service.warmUpStatus).toBe('no_docker');
    jest.restoreAllMocks();
  });

  // ── shared workspace (red + no-red) ───────────────────────────────────────

  it('shares the same hostDir between normal session and network session of the same task', async () => {
    process.env.EVA_SANDBOX_ALLOW_NETWORK = 'true';
    await service.execInSession('task-shared', { kind: 'python', code: 'print(1)' });
    await service.execInSession('task-shared', { kind: 'python', code: 'print(2)', network: true });

    expect(service.hasSession('task-shared')).toBe(true);
    const normalHostDir = service.getHostDir('task-shared');
    const netHostDir = service.getNetworkHostDir('task-shared');

    expect(normalHostDir).toBe(netHostDir);
    expect(normalHostDir).not.toBeNull();
    delete process.env.EVA_SANDBOX_ALLOW_NETWORK;
  });

  it('passes network settings to Node one-shot runs', async () => {
    process.env.EVA_SANDBOX_ALLOW_NETWORK = 'true';
    await service.execInSession('task-node-net', { kind: 'node', code: 'console.log(1)', network: true });

    const run = dockerCalls.find((c) => c.args[0] === 'run' && c.args.includes('node:20-alpine'));
    expect(run).toBeDefined();
    expect(run!.args).toEqual(expect.arrayContaining(['--network', 'bridge']));
    delete process.env.EVA_SANDBOX_ALLOW_NETWORK;
  });
});
