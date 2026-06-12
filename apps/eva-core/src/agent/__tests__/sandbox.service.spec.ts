import { SandboxService } from '../sandbox.service';
import { IntegrationsService } from '../../integrations/integrations.service';

type DockerCall = { args: string[] };

describe('SandboxService', () => {
  let service: SandboxService;
  let dockerCalls: DockerCall[];
  let dockerSpy: jest.SpyInstance;
  let integrations: { getSecret: jest.Mock; list: jest.Mock };

  beforeEach(() => {
    integrations = {
      getSecret: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
    };
    service = new SandboxService(integrations as unknown as IntegrationsService);
    jest.spyOn(service, 'dockerAvailable').mockResolvedValue(true);

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

  it('creates the session container once and reuses it across steps', async () => {
    await service.execInSession('task-1', { kind: 'python', code: 'print(1)' });
    await service.execInSession('task-1', { kind: 'python', code: 'print(2)' });

    const creates = dockerCalls.filter((c) => c.args[0] === 'run' && c.args.includes('-d'));
    const execs = dockerCalls.filter((c) => c.args[0] === 'exec');
    expect(creates).toHaveLength(1);
    expect(creates[0].args).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', 'tail']));
    expect(execs).toHaveLength(2);
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

  it('runs terminal commands inside the session workdir', async () => {
    await service.execInSession('task-1', { kind: 'terminal', code: 'ls -la' });

    const exec = dockerCalls.find((c) => c.args[0] === 'exec');
    expect(exec!.args.join(' ')).toContain('cd /work && ls -la');
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

  it('returns timeout/error details as observations instead of throwing', async () => {
    dockerSpy.mockImplementation(async (args: string[]) => {
      dockerCalls.push({ args });
      if (args[0] === 'image') throw new Error('no such image');
      if (args[0] === 'run' && args.includes('-d')) return { stdout: 'cid', stderr: '' };
      const err = new Error('Command failed') as Error & { killed?: boolean; stdout?: string; stderr?: string };
      err.killed = false;
      err.stdout = '';
      err.stderr = 'SyntaxError: invalid syntax';
      throw err;
    });

    const result = await service.execInSession('task-1', { kind: 'python', code: 'print(' });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('SyntaxError');
  });
});
