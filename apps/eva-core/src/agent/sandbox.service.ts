import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { IntegrationsService } from '../integrations/integrations.service';

const execFileAsync = promisify(execFile);

export type SandboxLanguage = 'python' | 'node' | 'bash';

export interface SandboxRunResult {
  ok: boolean;
  /** stdout+stderr combinados, truncados y con secrets enmascarados. */
  output: string;
  timedOut?: boolean;
  error?: string;
}

export interface OneShotOptions {
  language: SandboxLanguage;
  code: string;
  orgId?: string;
  filename?: string;
  timeoutMs?: number;
  /** true → contenedor con red (solo para ejecuciones aprobadas). */
  network?: boolean;
}

export interface SessionExecOptions {
  kind: SandboxLanguage | 'terminal';
  /** Código fuente (python/node/bash) o comando de shell (terminal). */
  code: string;
  orgId?: string;
  timeoutMs?: number;
  /** terminal: lanza el comando en background y vuelve de inmediato. */
  background?: boolean;
}

interface SandboxSession {
  containerName: string;
  hostDir: string;
  image: string;
  lastUsedAt: number;
  stepCount: number;
}

/** Alias de secret en código generado: §§secret(provider) o §§secret(kind.provider). */
const SECRET_ALIAS = /§§secret\(([\w][\w.-]*)\)/g;

const OUTPUT_LIMIT = 4000;
const DEFAULT_TIMEOUT_MS = 60_000;
const SESSION_IDLE_TTL_MS = 15 * 60_000;
const BG_LOG = '.eva-bg.log';

/** Imágenes one-shot por lenguaje — sin red, recursos acotados, autodestruidas. */
const ONE_SHOT_IMAGES: Record<SandboxLanguage, { image: string; cmd: (file: string) => string[] }> = {
  python: { image: 'python:3.12-alpine', cmd: (file) => ['python', file] },
  node:   { image: 'node:20-alpine',     cmd: (file) => ['node', file] },
  bash:   { image: 'alpine:3.20',        cmd: (file) => ['sh', file] },
};

/** Imagen enriquecida (requests/pandas/numpy/openpyxl/pillow) — ver docker/sandbox. */
const ENRICHED_IMAGE = 'eva-sandbox:latest';

const FILE_EXT: Record<SandboxLanguage, string> = { python: 'py', node: 'js', bash: 'sh' };

/**
 * SandboxService — la "computadora" de EVA (estilo agent-zero, multi-tenant safe).
 *
 * Dos modos:
 * - runOneShot(): contenedor desechable por ejecución (sin red salvo aprobación,
 *   rootfs read-only, recursos acotados). Hereda el comportamiento de script-forge.
 * - Sesión por tarea: un contenedor de trabajo persistente (taskId) con /work
 *   montado rw; archivos y procesos en background sobreviven entre pasos del
 *   agent-loop. node corre one-shot compartiendo el MISMO /work, así que el
 *   estado (archivos) es común a todos los lenguajes.
 *
 * Secrets: el código puede referir §§secret(provider) — se sustituye el valor
 * real justo antes de ejecutar y se enmascara en la salida; el modelo nunca lo ve.
 */
@Injectable()
export class SandboxService implements OnModuleDestroy {
  private readonly logger = new Logger(SandboxService.name);
  private readonly sessions = new Map<string, SandboxSession>();
  private dockerCheck?: Promise<boolean>;
  private enrichedImageCheck?: Promise<boolean>;
  private readonly reaper: NodeJS.Timeout;

  constructor(@Optional() private readonly integrations?: IntegrationsService) {
    this.reaper = setInterval(() => void this.reapIdleSessions(), 60_000);
    this.reaper.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((taskId) => this.release(taskId)));
  }

  async dockerAvailable(): Promise<boolean> {
    this.dockerCheck ??= execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    return this.dockerCheck;
  }

  // ── one-shot (script-forge y ejecuciones aprobadas con red) ───────────────

  async runOneShot(opts: OneShotOptions): Promise<SandboxRunResult> {
    if (!(await this.dockerAvailable())) {
      return { ok: false, output: '', error: 'Docker no disponible en este nodo' };
    }

    const resolved = await this.resolveSecrets(opts.code, opts.orgId);
    if (resolved.error) return { ok: false, output: '', error: resolved.error };

    const runtime = ONE_SHOT_IMAGES[opts.language] ?? ONE_SHOT_IMAGES.bash;
    const image = opts.language === 'python' && (await this.enrichedImageAvailable())
      ? ENRICHED_IMAGE
      : runtime.image;
    const filename = this.safeFilename(opts.filename ?? `script.${FILE_EXT[opts.language] ?? 'sh'}`);
    const dir = await mkdtemp(join(tmpdir(), 'eva-sbx-'));

    try {
      await writeFile(join(dir, filename), resolved.code, 'utf8');
      const { stdout, stderr } = await this.runDocker([
        'run', '--rm',
        '--network', opts.network ? 'bridge' : 'none',
        '--memory', '256m',
        '--cpus', '0.5',
        '--read-only',
        '-v', `${dir}:/work`,
        '-w', '/work',
        image,
        ...runtime.cmd(filename),
      ], { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 512 });
      return { ok: true, output: this.formatOutput(stdout, stderr, resolved.masks) };
    } catch (error) {
      return this.execError(error, resolved.masks);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── sesión persistente por tarea ──────────────────────────────────────────

  async execInSession(taskId: string, opts: SessionExecOptions): Promise<SandboxRunResult> {
    if (!(await this.dockerAvailable())) {
      return { ok: false, output: '', error: 'Docker no disponible en este nodo' };
    }

    const resolved = await this.resolveSecrets(opts.code, opts.orgId);
    if (resolved.error) return { ok: false, output: '', error: resolved.error };

    const session = await this.getOrCreateSession(taskId);
    if (!session) return { ok: false, output: '', error: 'No se pudo crear la sesión sandbox' };
    session.lastUsedAt = Date.now();
    session.stepCount += 1;

    // node no está en la imagen de sesión (python) — corre one-shot sobre el MISMO /work.
    if (opts.kind === 'node') {
      return this.runNodeOnSharedWorkspace(session, resolved.code, resolved.masks, opts.timeoutMs);
    }

    try {
      if (opts.kind === 'terminal') {
        if (opts.background) {
          await this.runDocker([
            'exec', '-d', session.containerName,
            'sh', '-c', `cd /work && { ${resolved.code} ; } >> /work/${BG_LOG} 2>&1`,
          ], { timeout: 10_000, maxBuffer: 1024 * 64 });
          return { ok: true, output: `Proceso lanzado en background. Usa terminal_output para leer su salida (log: /work/${BG_LOG}).` };
        }
        const { stdout, stderr } = await this.runDocker([
          'exec', session.containerName,
          'sh', '-c', `cd /work && ${resolved.code}`,
        ], { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 1024 * 512 });
        return { ok: true, output: this.formatOutput(stdout, stderr, resolved.masks) };
      }

      // python / bash: el archivo va al workspace (host) y se ejecuta dentro.
      const file = `step-${session.stepCount}.${FILE_EXT[opts.kind]}`;
      await writeFile(join(session.hostDir, file), resolved.code, 'utf8');
      const interp = opts.kind === 'python' ? 'python' : 'sh';
      const { stdout, stderr } = await this.runDocker([
        'exec', '-w', '/work', session.containerName,
        interp, file,
      ], { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 512 });
      return { ok: true, output: this.formatOutput(stdout, stderr, resolved.masks) };
    } catch (error) {
      return this.execError(error, resolved.masks);
    }
  }

  async readBackgroundOutput(taskId: string): Promise<SandboxRunResult> {
    const session = this.sessions.get(taskId);
    if (!session) return { ok: false, output: '', error: 'No hay sesión sandbox activa para esta tarea' };
    session.lastUsedAt = Date.now();
    try {
      const { stdout } = await this.runDocker([
        'exec', session.containerName,
        'sh', '-c', `tail -c ${OUTPUT_LIMIT} /work/${BG_LOG} 2>/dev/null || echo "(sin salida de background todavía)"`,
      ], { timeout: 10_000, maxBuffer: 1024 * 64 });
      return { ok: true, output: stdout.trim() || '(sin salida de background todavía)' };
    } catch (error) {
      return this.execError(error, []);
    }
  }

  /** Libera contenedor + workspace de la tarea. Idempotente y best-effort. */
  async release(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) return;
    this.sessions.delete(taskId);
    await this.runDocker(['rm', '-f', session.containerName], { timeout: 15_000, maxBuffer: 1024 * 16 })
      .catch(() => undefined);
    await rm(session.hostDir, { recursive: true, force: true }).catch(() => undefined);
    this.logger.log(`sandbox session released for task ${taskId} (${session.stepCount} pasos)`);
  }

  hasSession(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  // ── secrets ───────────────────────────────────────────────────────────────

  /**
   * Sustituye §§secret(provider) / §§secret(kind.provider) por el valor real
   * (kind por defecto: credential). Los valores jamás pasan por el modelo:
   * entran aquí y se enmascaran en la salida.
   */
  private async resolveSecrets(code: string, orgId?: string): Promise<{ code: string; masks: Array<{ value: string; alias: string }>; error?: string }> {
    const refs = [...new Set([...code.matchAll(SECRET_ALIAS)].map((m) => m[1]))];
    if (refs.length === 0) return { code, masks: [] };
    if (!orgId || !this.integrations) {
      return { code, masks: [], error: 'ERROR: el código usa §§secret(...) pero no hay acceso a credenciales en este contexto' };
    }

    let resolved = code;
    const masks: Array<{ value: string; alias: string }> = [];
    for (const ref of refs) {
      const [kind, provider] = ref.includes('.') ? ref.split('.', 2) : ['credential', ref];
      const value = await this.integrations
        .getSecret(orgId, kind as 'model' | 'channel' | 'credential', provider)
        .catch(() => null);
      if (!value) {
        return { code, masks: [], error: `ERROR: no existe el secret "${ref}". Revisa los alias disponibles.` };
      }
      const alias = `§§secret(${ref})`;
      resolved = resolved.split(alias).join(value);
      masks.push({ value, alias });
    }
    return { code: resolved, masks };
  }

  // ── private ───────────────────────────────────────────────────────────────

  private async getOrCreateSession(taskId: string): Promise<SandboxSession | null> {
    const existing = this.sessions.get(taskId);
    if (existing) return existing;

    const image = (await this.enrichedImageAvailable()) ? ENRICHED_IMAGE : ONE_SHOT_IMAGES.python.image;
    const containerName = `eva-sbx-${createHash('md5').update(taskId).digest('hex').slice(0, 12)}`;
    const hostDir = await mkdtemp(join(tmpdir(), 'eva-sbx-ws-'));

    try {
      await this.runDocker([
        'run', '-d', '--rm',
        '--name', containerName,
        '--network', 'none',
        '--memory', '512m',
        '--cpus', '1',
        '--read-only',
        '--tmpfs', '/tmp',
        '-v', `${hostDir}:/work`,
        '-w', '/work',
        image,
        'tail', '-f', '/dev/null',
      ], { timeout: 60_000, maxBuffer: 1024 * 64 });
    } catch (error) {
      await rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
      this.logger.warn(`sandbox session create failed: ${(error as Error).message.slice(0, 200)}`);
      return null;
    }

    const session: SandboxSession = { containerName, hostDir, image, lastUsedAt: Date.now(), stepCount: 0 };
    this.sessions.set(taskId, session);
    this.logger.log(`sandbox session ${containerName} (${image}) created for task ${taskId}`);
    return session;
  }

  private async runNodeOnSharedWorkspace(
    session: SandboxSession,
    code: string,
    masks: Array<{ value: string; alias: string }>,
    timeoutMs?: number,
  ): Promise<SandboxRunResult> {
    const file = `step-${session.stepCount}.js`;
    try {
      await writeFile(join(session.hostDir, file), code, 'utf8');
      const { stdout, stderr } = await this.runDocker([
        'run', '--rm',
        '--network', 'none',
        '--memory', '256m',
        '--cpus', '0.5',
        '--read-only',
        '-v', `${session.hostDir}:/work`,
        '-w', '/work',
        ONE_SHOT_IMAGES.node.image,
        'node', file,
      ], { timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 512 });
      return { ok: true, output: this.formatOutput(stdout, stderr, masks) };
    } catch (error) {
      return this.execError(error, masks);
    }
  }

  private async enrichedImageAvailable(): Promise<boolean> {
    const override = process.env.EVA_SANDBOX_IMAGE;
    if (override === '') return false;
    this.enrichedImageCheck ??= this.runDocker(['image', 'inspect', override ?? ENRICHED_IMAGE, '--format', '{{.Id}}'], {
      timeout: 5000, maxBuffer: 1024 * 16,
    }).then(() => true).catch(() => false);
    return this.enrichedImageCheck;
  }

  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [taskId, session] of this.sessions) {
      if (now - session.lastUsedAt > SESSION_IDLE_TTL_MS) {
        this.logger.log(`reaping idle sandbox session for task ${taskId}`);
        await this.release(taskId);
      }
    }
  }

  /** Capa única de salida: combina, filtra ruido de docker pull, trunca y enmascara secrets. */
  private formatOutput(stdout: string, stderr: string, masks: Array<{ value: string; alias: string }>): string {
    const cleanStderr = stderr
      .split('\n')
      .filter((line) => !/^(Unable to find image|.*: (Pulling|Pull complete|Download complete|Pulling fs layer|Waiting|Verifying Checksum|Already exists)|Digest: sha256:|Status: Downloaded|.+Pulling from )/.test(line.trim()))
      .join('\n');
    let output = [stdout, cleanStderr].filter((s) => s.trim()).join('\n').trim().slice(0, OUTPUT_LIMIT);
    for (const { value, alias } of masks) {
      output = output.split(value).join(alias);
    }
    return output;
  }

  private execError(error: unknown, masks: Array<{ value: string; alias: string }>): SandboxRunResult {
    const err = error as Error & { killed?: boolean; stdout?: string; stderr?: string };
    const timedOut = err.killed === true;
    const detail = this.formatOutput(err.stdout ?? '', err.stderr ?? '', masks) || this.maskText(err.message.slice(0, 500), masks);
    return {
      ok: false,
      output: detail,
      timedOut,
      error: timedOut ? 'Tiempo de ejecución agotado' : this.maskText(err.message.slice(0, 300), masks),
    };
  }

  private maskText(text: string, masks: Array<{ value: string; alias: string }>): string {
    let masked = text;
    for (const { value, alias } of masks) masked = masked.split(value).join(alias);
    return masked;
  }

  private safeFilename(name: string): string {
    return name.replace(/[^\w.\-]/g, '_');
  }

  /** Único punto de contacto con el binario docker — spyable en tests. */
  protected runDocker(args: string[], opts: { timeout: number; maxBuffer: number }): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('docker', args, opts);
  }
}
