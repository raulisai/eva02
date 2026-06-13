import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { IntegrationsService } from '../integrations/integrations.service';
import {
  PersistentShell,
  ShellProcess,
  ShellTimeouts,
  DEFAULT_SHELL_TIMEOUTS,
} from './sandbox-shell';

const execFileAsync = promisify(execFile);

type SecretMask = { value: string; alias: string };

export type SandboxLanguage = 'python' | 'node' | 'bash';

export interface SandboxRunResult {
  ok: boolean;
  /** stdout+stderr combinados, truncados y con secrets enmascarados. */
  output: string;
  timedOut?: boolean;
  error?: string;
  /**
   * Estado de un comando ejecutado en el shell persistente:
   *  - completed: terminó (exitCode disponible).
   *  - running: sigue corriendo; reanuda con readShellOutput.
   *  - awaiting_input: espera stdin; responde con sendShellInput.
   */
  status?: 'completed' | 'running' | 'awaiting_input';
  exitCode?: number;
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
  /** true → ejecutar con acceso a red (solo cuando EVA_SANDBOX_ALLOW_NETWORK=true). */
  network?: boolean;
  /** Número de shell multiplexado dentro del contenedor (0 por defecto). */
  session?: number;
  /** Overrides de los timeouts multi-fase del shell persistente. */
  timeouts?: Partial<ShellTimeouts>;
}

export interface SessionInputOptions {
  /** Texto a enviar al stdin del comando que espera input. */
  keyboard: string;
  session?: number;
  network?: boolean;
  timeouts?: Partial<ShellTimeouts>;
}

export interface SessionReadOptions {
  session?: number;
  network?: boolean;
  timeouts?: Partial<ShellTimeouts>;
}

interface SandboxSession {
  containerName: string;
  hostDir: string;
  image: string;
  lastUsedAt: number;
  stepCount: number;
  /** true → este contenedor tiene --network bridge (para downloads, yt-dlp, etc.) */
  networkEnabled: boolean;
  /** Shells persistentes multiplexados por número (estado vivo entre pasos). */
  shells: Map<number, PersistentShell>;
  /** Masks de secrets por shell — para enmascarar la salida en reanudaciones. */
  shellMasks: Map<number, SecretMask[]>;
}

/** Alias de secret en código generado: §§secret(provider) o §§secret(kind.provider). */
const SECRET_ALIAS = /§§secret\(([\w][\w.-]*)\)/g;

const OUTPUT_LIMIT = 4000;
const DEFAULT_TIMEOUT_MS = 60_000;
const SESSION_IDLE_TTL_MS = 15 * 60_000;
const BG_LOG = '.eva-bg.log';
/** TTL del check de Docker: un resultado negativo caduca rápido para re-detectar el daemon. */
const DOCKER_CHECK_OK_TTL_MS = 5 * 60_000;
const DOCKER_CHECK_FAIL_TTL_MS = 30_000;
/** TTL del check de imagen enriquecida: si se construye después, se detecta sin reiniciar. */
const ENRICHED_CHECK_OK_TTL_MS = 60 * 60_000;
const ENRICHED_CHECK_FAIL_TTL_MS = 60_000;

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
/** Estado del warm-up para el health check. */
export type SandboxWarmUpStatus = 'pending' | 'ready' | 'no_docker' | 'no_enriched_image';

/** Máximo de reintentos del warm-up al arranque (cada 30 s → 10 min). */
const WARMUP_MAX_RETRIES = 20;
const WARMUP_RETRY_MS = 30_000;

@Injectable()
export class SandboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SandboxService.name);
  private readonly sessions = new Map<string, SandboxSession>();
  private dockerCheck?: { value: boolean; checkedAt: number };
  private enrichedImageCheck?: { value: boolean; checkedAt: number };
  private readonly reaper: NodeJS.Timeout;

  /** Estado visible para el health check. */
  warmUpStatus: SandboxWarmUpStatus = 'pending';

  /**
   * Nombre fijo del contenedor standby — siempre visible en Docker Desktop.
   * Cuando una tarea lo adopta, se crea un reemplazo en background.
   */
  private readonly STANDBY_NAME = 'eva-standby';
  standbyReady = false;

  constructor(@Optional() private readonly integrations?: IntegrationsService) {
    this.reaper = setInterval(() => void this.reapIdleSessions(), 60_000);
    this.reaper.unref();
  }

  /**
   * Warm-up: la "computadora" de EVA debe estar lista ANTES de la primera tarea.
   * Reintenta en background hasta WARMUP_MAX_RETRIES veces si Docker no responde
   * al arranque (p.ej. Docker Desktop todavía inicializando).
   */
  onApplicationBootstrap() {
    void this.warmUpWithRetry();
  }

  async onModuleDestroy() {
    clearInterval(this.reaper);
    // Limpia todas las sesiones activas y el standby.
    await Promise.all([...this.sessions.keys()].map((taskId) => this.release(taskId)));
    if (this.standbyReady) {
      await this.runDocker(['rm', '-f', this.STANDBY_NAME], { timeout: 10_000, maxBuffer: 1024 * 16 }).catch(() => undefined);
      this.standbyReady = false;
      this.logger.log('sandbox standby: detenido al apagar el servicio');
    }
  }


  /**
   * Warm-up con retry automático. Si Docker no está disponible al arrancar
   * (p.ej. Docker Desktop todavía inicializando), reintenta cada WARMUP_RETRY_MS
   * hasta WARMUP_MAX_RETRIES veces — sin bloquear el proceso.
   */
  async warmUpWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= WARMUP_MAX_RETRIES; attempt++) {
      const ready = await this.warmUp();
      if (ready) return;
      if (attempt < WARMUP_MAX_RETRIES) {
        this.logger.warn(`sandbox warm-up: Docker no disponible (intento ${attempt}/${WARMUP_MAX_RETRIES}) — reintentando en ${WARMUP_RETRY_MS / 1000}s`);
        await new Promise<void>((resolve) => setTimeout(resolve, WARMUP_RETRY_MS).unref());
        // Fuerza re-check limpiando el caché del check anterior.
        this.dockerCheck = undefined;
      } else {
        this.logger.error('sandbox warm-up: Docker no pudo alcanzarse tras todos los reintentos. El sandbox estará inactivo hasta que Docker esté disponible.');
        this.warmUpStatus = 'no_docker';
      }
    }
  }

  /**
   * Verifica Docker y deja las imágenes pre-descargadas para que la primera
   * ejecución no pague un `docker pull` (ni falle por imagen ausente).
   * Retorna true si el sandbox quedó listo, false si Docker no estaba disponible.
   * Best-effort: nunca tira el bootstrap del proceso.
   */
  async warmUp(): Promise<boolean> {
    try {
      if (!(await this.dockerAvailable())) {
        return false;
      }
      if (await this.enrichedImageAvailable()) {
        this.logger.log(`sandbox warm-up: ✓ Docker listo, imagen enriquecida ${process.env.EVA_SANDBOX_IMAGE || ENRICHED_IMAGE} disponible — EVA tiene su computadora lista`);
        this.warmUpStatus = 'ready';
      } else {
        this.logger.warn(`sandbox warm-up: ✓ Docker listo, pero imagen enriquecida ausente — construye "docker build -t ${ENRICHED_IMAGE.replace(':latest', '')} docker/sandbox"; usando fallbacks alpine`);
        this.warmUpStatus = 'no_enriched_image';
      }
      // Pre-pull de los fallbacks en background — no bloquea el arranque.
      for (const { image } of Object.values(ONE_SHOT_IMAGES)) {
        void this.runDocker(['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 5000, maxBuffer: 1024 * 16 })
          .catch(() => this.runDocker(['pull', image], { timeout: 120_000, maxBuffer: 1024 * 256 })
            .then(() => this.logger.log(`sandbox warm-up: imagen ${image} descargada`))
            .catch((err) => this.logger.warn(`sandbox warm-up: no pude descargar ${image}: ${(err as Error).message.slice(0, 120)}`)));
      }
      // Lanza el contenedor standby — visible en Docker Desktop, listo para la primera tarea.
      void this.ensureStandby();
      return true;
    } catch (error) {
      this.logger.warn(`sandbox warm-up falló: ${(error as Error).message.slice(0, 200)}`);
      return false;
    }
  }

  /**
   * Levanta el contenedor eva-standby si no está corriendo.
   * Es el "motor siempre encendido" de EVA — visible en Docker Desktop.
   */
  async ensureStandby(): Promise<void> {
    try {
      // ¿Ya corre?
      const { stdout } = await this.runDocker(
        ['inspect', '--format', '{{.State.Status}}', this.STANDBY_NAME],
        { timeout: 5000, maxBuffer: 1024 * 16 },
      ).catch(() => ({ stdout: '', stderr: '' }));

      if (stdout.trim() === 'running') {
        this.standbyReady = true;
        this.logger.log(`sandbox standby: ✓ ${this.STANDBY_NAME} ya estaba corriendo`);
        return;
      }

      // Limpia restos de ejecuciones anteriores.
      await this.runDocker(['rm', '-f', this.STANDBY_NAME], { timeout: 10_000, maxBuffer: 1024 * 16 }).catch(() => undefined);

      const image = (await this.enrichedImageAvailable()) ? ENRICHED_IMAGE : ONE_SHOT_IMAGES.python.image;
      await this.runDocker([
        'run', '-d', '--rm',
        '--name', this.STANDBY_NAME,
        '--network', 'none',
        '--memory', '512m',
        '--cpus', '1',
        '--read-only', '--tmpfs', '/tmp',
        '-l', 'eva.role=standby',
        image,
        'tail', '-f', '/dev/null',
      ], { timeout: 30_000, maxBuffer: 1024 * 64 });

      this.standbyReady = true;
      this.logger.log(`sandbox standby: ✓ ${this.STANDBY_NAME} (${image}) levantado — EVA computer visible en Docker Desktop`);
    } catch (err) {
      this.logger.warn(`sandbox standby: no pude levantar ${this.STANDBY_NAME}: ${(err as Error).message.slice(0, 200)}`);
      this.standbyReady = false;
    }
  }


  /**
   * Disponibilidad con TTL: un "no" de hace un rato no condena al proceso —
   * si el daemon de Docker se levanta después, EVA lo vuelve a encontrar sola.
   */
  async dockerAvailable(): Promise<boolean> {
    const now = Date.now();
    const ttl = this.dockerCheck?.value ? DOCKER_CHECK_OK_TTL_MS : DOCKER_CHECK_FAIL_TTL_MS;
    if (this.dockerCheck && now - this.dockerCheck.checkedAt < ttl) return this.dockerCheck.value;
    const value = await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    this.dockerCheck = { value, checkedAt: now };
    return value;
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

    // Red: solo permitida si el flag global está activo.
    const networkRequested = opts.network === true && process.env.EVA_SANDBOX_ALLOW_NETWORK === 'true';
    if (opts.network === true && !networkRequested) {
      return { ok: false, output: '', error: 'ERROR: la sesión con red requiere EVA_SANDBOX_ALLOW_NETWORK=true en el servidor' };
    }

    const resolved = await this.resolveSecrets(opts.code, opts.orgId);
    if (resolved.error) return { ok: false, output: '', error: resolved.error };

    const session = await this.getOrCreateSession(taskId, networkRequested);
    if (!session) {
      // Resiliencia: sin sesión persistente, el paso aún puede correr one-shot
      // (se pierde /work entre pasos, pero la tarea no se queda sin computadora).
      this.logger.warn(`sandbox session unavailable for task ${taskId} — falling back to one-shot exec`);
      const language: SandboxLanguage = opts.kind === 'terminal' ? 'bash' : opts.kind;
      const result = await this.runOneShot({ language, code: opts.code, orgId: opts.orgId, timeoutMs: opts.timeoutMs });
      if (result.ok) {
        result.output = `${result.output}\n[aviso: sin sesión persistente — /work no conserva archivos entre pasos]`.trim();
      }
      return result;
    }
    session.lastUsedAt = Date.now();
    session.stepCount += 1;

    // node no está en la imagen de sesión (python) — corre one-shot sobre el MISMO /work.
    if (opts.kind === 'node') {
      return this.runNodeOnSharedWorkspace(session, resolved.code, resolved.masks, opts.timeoutMs, networkRequested);
    }

    // terminal en background → proceso detached con log (orthogonal al shell vivo).
    if (opts.kind === 'terminal' && opts.background) {
      return this.runDetachedBackground(session, resolved.code, resolved.masks);
    }

    // Foreground (terminal/python/bash) → shell PERSISTENTE: el estado (env, cwd,
    // procesos) sobrevive entre pasos, con timeouts multi-fase y detección de diálogo.
    const sessionNum = opts.session ?? 0;
    const shellRes = await this.execViaShell(session, sessionNum, opts.kind, resolved.code, resolved.masks, opts.timeouts);
    if (shellRes) return shellRes;

    // Shell no disponible (imagen sin bash, spawn falló) → exec stateless de respaldo.
    return this.execStateless(session, opts.kind, resolved.code, resolved.masks, opts.timeoutMs);
  }

  /**
   * Envía texto al stdin de un comando que espera input (diálogo detectado) y
   * reanuda la lectura. Espejo del tool `input` de Agent Zero.
   */
  async sendShellInput(taskId: string, opts: SessionInputOptions): Promise<SandboxRunResult> {
    const { session, num } = this.resolveShell(taskId, opts.session ?? 0, opts.network === true);
    if (!session) return { ok: false, output: '', error: 'No hay sesión sandbox activa para esta tarea.' };
    const shell = session.shells.get(num);
    if (!shell || shell.exited) return { ok: false, output: '', error: `No hay un shell vivo en la sesión ${num}.` };
    session.lastUsedAt = Date.now();
    const res = await shell.sendInput(opts.keyboard, this.mergeTimeouts(opts.timeouts));
    return this.shellResultToSandbox(res, session.shellMasks.get(num) ?? []);
  }

  /** Reanuda la lectura de un comando del shell que seguía corriendo. */
  async readShellOutput(taskId: string, opts: SessionReadOptions = {}): Promise<SandboxRunResult> {
    const { session, num } = this.resolveShell(taskId, opts.session ?? 0, opts.network === true);
    if (!session) return { ok: false, output: '', error: 'No hay sesión sandbox activa para esta tarea.' };
    const shell = session.shells.get(num);
    if (!shell || shell.exited) {
      // Sin shell vivo: cae a leer el log del proceso en background.
      return this.readBackgroundOutput(taskId);
    }
    session.lastUsedAt = Date.now();
    const res = await shell.read(this.mergeTimeouts(opts.timeouts));
    return this.shellResultToSandbox(res, session.shellMasks.get(num) ?? []);
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

  /** Libera contenedor + workspace de la tarea. Libera ambas sesiones (red y no-red). Idempotente. */
  async release(taskId: string): Promise<void> {
    const baseId = taskId.replace(/:net$/, '');
    const keys = [baseId, `${baseId}:net`];
    let hostDirToDelete: string | null = null;
    for (const key of keys) {
      const session = this.sessions.get(key);
      if (!session) continue;
      this.sessions.delete(key);
      // Cerrar shells vivos antes de tumbar el contenedor.
      for (const shell of session.shells.values()) shell.close();
      session.shells.clear();
      await this.runDocker(['rm', '-f', session.containerName], { timeout: 15_000, maxBuffer: 1024 * 16 })
        .catch(() => undefined);
      hostDirToDelete = session.hostDir;
      this.logger.log(`sandbox session released for task ${baseId} key=${key} (${session.stepCount} pasos)`);
    }
    if (hostDirToDelete) {
      await rm(hostDirToDelete, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  hasSession(taskId: string): boolean {
    return this.sessions.has(taskId) || this.sessions.has(`${taskId}:net`);
  }

  /** Devuelve el hostDir de la sesión (preferring network session if it exists, for file access). */
  getHostDir(taskId: string): string | null {
    return this.sessions.get(`${taskId}:net`)?.hostDir
      ?? this.sessions.get(taskId)?.hostDir
      ?? null;
  }

  /** Devuelve el hostDir específico de la sesión de red (para acceso a archivos descargados). */
  getNetworkHostDir(taskId: string): string | null {
    return this.sessions.get(`${taskId}:net`)?.hostDir ?? null;
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

  private async getOrCreateSession(taskId: string, networkEnabled = false): Promise<SandboxSession | null> {
    // Clave de sesión: red y no-red son contenedores separados en la misma tarea.
    const sessionKey = networkEnabled ? `${taskId}:net` : taskId;
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const image = (await this.enrichedImageAvailable()) ? ENRICHED_IMAGE : ONE_SHOT_IMAGES.python.image;
    const suffix = networkEnabled ? 'net' : 'iso';
    const containerName = `eva-sbx-${createHash('md5').update(taskId).digest('hex').slice(0, 10)}-${suffix}`;
    
    // Compartir hostDir si la otra sesión (red o no-red) de esta tarea ya existe
    const otherKey = networkEnabled ? taskId : `${taskId}:net`;
    const otherSession = this.sessions.get(otherKey);
    const hostDir = otherSession ? otherSession.hostDir : await mkdtemp(join(tmpdir(), 'eva-sbx-ws-'));

    // Si el standby está listo y no necesitamos red, liberamos el standby ahora
    // para que el nombre 'eva-standby' quede libre antes de recrearlo.
    // El valor del standby es tener la imagen precargada en memoria → el nuevo
    // docker run tarda ~200ms en vez de segundos.
    if (!networkEnabled && this.standbyReady) {
      this.standbyReady = false;
      await this.runDocker(['rm', '-f', this.STANDBY_NAME], { timeout: 10_000, maxBuffer: 1024 * 16 }).catch(() => undefined);
    }

    try {
      const dockerArgs = [
        'run', '-d', '--rm',
        '--name', containerName,
        '--network', networkEnabled ? 'bridge' : 'none',
        '--memory', networkEnabled ? '1g' : '512m',
        '--cpus', networkEnabled ? '1.5' : '1',
        ...(!networkEnabled ? ['--read-only', '--tmpfs', '/tmp'] : []),
        '-v', `${hostDir}:/work`,
        '-w', '/work',
        image,
        'tail', '-f', '/dev/null',
      ];
      await this.runDocker(dockerArgs, { timeout: 60_000, maxBuffer: 1024 * 64 });
    } catch (error) {
      await rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
      this.logger.warn(`sandbox session create failed: ${(error as Error).message.slice(0, 200)}`);
      return null;
    }

    const session: SandboxSession = {
      containerName, hostDir, image,
      lastUsedAt: Date.now(), stepCount: 0,
      networkEnabled,
      shells: new Map(),
      shellMasks: new Map(),
    };
    this.sessions.set(sessionKey, session);
    this.logger.log(`sandbox session ${containerName} (${image}, net=${networkEnabled}) ready for task ${taskId}`);

    // Reponer el standby inmediatamente después de asignar la sesión.
    if (!networkEnabled) {
      void this.ensureStandby();
    }

    return session;
  }

  private async runNodeOnSharedWorkspace(
    session: SandboxSession,
    code: string,
    masks: Array<{ value: string; alias: string }>,
    timeoutMs?: number,
    networkEnabled = false,
  ): Promise<SandboxRunResult> {
    const file = `step-${session.stepCount}.js`;
    try {
      await writeFile(join(session.hostDir, file), code, 'utf8');
      const { stdout, stderr } = await this.runDocker([
        'run', '--rm',
        '--network', networkEnabled ? 'bridge' : 'none',
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

  // ── shell persistente (PTY vivo) ──────────────────────────────────────────

  /**
   * Ejecuta código foreground en el shell persistente de la sesión. Para
   * python/bash escribe un archivo y lo corre con el intérprete DENTRO del
   * shell vivo, así cwd y variables exportadas en pasos previos aplican.
   * Devuelve null si no se pudo obtener un shell (para caer al fallback).
   */
  private async execViaShell(
    session: SandboxSession,
    num: number,
    kind: SandboxLanguage | 'terminal',
    code: string,
    masks: SecretMask[],
    timeouts?: Partial<ShellTimeouts>,
  ): Promise<SandboxRunResult | null> {
    const shell = await this.getOrCreateShell(session, num);
    if (!shell) return null;

    session.shellMasks.set(num, masks);

    let command: string;
    if (kind === 'terminal') {
      command = code;
    } else {
      const file = `.eva-s${num}-step-${session.stepCount}.${FILE_EXT[kind]}`;
      try {
        await writeFile(join(session.hostDir, file), code, 'utf8');
      } catch (err) {
        return this.execError(err, masks);
      }
      command = kind === 'python' ? `python ${file}` : `sh ${file}`;
    }

    try {
      const res = await shell.run(command, this.mergeTimeouts(timeouts));
      return this.shellResultToSandbox(res, masks);
    } catch (err) {
      this.logger.warn(`shell run failed on ${session.containerName}: ${(err as Error).message.slice(0, 160)}`);
      return null;
    }
  }

  private async getOrCreateShell(session: SandboxSession, num: number): Promise<PersistentShell | null> {
    const existing = session.shells.get(num);
    if (existing && !existing.exited) return existing;
    if (existing) session.shells.delete(num);

    try {
      const proc = this.createShellProcess(session.containerName);
      const shell = new PersistentShell(proc);
      await shell.init();
      session.shells.set(num, shell);
      this.logger.debug(`persistent shell ${num} ready on ${session.containerName}`);
      return shell;
    } catch (err) {
      this.logger.warn(`shell spawn failed on ${session.containerName}: ${(err as Error).message.slice(0, 160)}`);
      return null;
    }
  }

  /**
   * Lanza el shell dentro del contenedor de la tarea. Usa `script` (util-linux)
   * para asignar un PTY real cuando existe — así los programas ven una terminal
   * (isatty) y emiten sus prompts interactivos —, y cae a bash/sh pelado si no.
   * Seam protegido para inyectar un proceso falso en tests.
   */
  protected createShellProcess(containerName: string): ShellProcess {
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

  /** Mapea el resultado del shell a SandboxRunResult, enmascarando secrets. */
  private shellResultToSandbox(res: { output: string; status: string; exitCode?: number }, masks: SecretMask[]): SandboxRunResult {
    const output = this.maskText(res.output, masks).slice(0, OUTPUT_LIMIT);
    if (res.status === 'completed') {
      const failed = (res.exitCode ?? 0) !== 0;
      const tail = failed ? `${output ? output + '\n' : ''}[exit code: ${res.exitCode}]` : output;
      return { ok: true, output: tail || '(sin salida)', status: 'completed', exitCode: res.exitCode };
    }
    if (res.status === 'awaiting_input') {
      return {
        ok: true,
        status: 'awaiting_input',
        output: `${output}\n[SISTEMA: el comando parece esperar input. Responde con terminal_input{"keyboard":"..."}, o reinícialo con terminal_run.]`.trim(),
      };
    }
    if (res.status === 'running') {
      return {
        ok: true,
        status: 'running',
        output: `${output}\n[SISTEMA: el proceso sigue corriendo. Usa terminal_output para leer más salida, o terminal_input si espera datos.]`.trim(),
      };
    }
    return { ok: false, output: output || 'El shell de la sesión terminó inesperadamente.', error: 'shell_error' };
  }

  /** terminal background: proceso detached que escribe a un log (lectura con readBackgroundOutput). */
  private async runDetachedBackground(session: SandboxSession, code: string, masks: SecretMask[]): Promise<SandboxRunResult> {
    try {
      await this.runDocker([
        'exec', '-d', session.containerName,
        'sh', '-c', `cd /work && { ${code} ; } >> /work/${BG_LOG} 2>&1`,
      ], { timeout: 10_000, maxBuffer: 1024 * 64 });
      return { ok: true, output: `Proceso lanzado en background. Usa terminal_output para leer su salida (log: /work/${BG_LOG}).` };
    } catch (error) {
      return this.execError(error, masks);
    }
  }

  /** Fallback sin estado de shell: un `docker exec` por paso (comportamiento previo). */
  private async execStateless(
    session: SandboxSession,
    kind: SandboxLanguage | 'terminal',
    code: string,
    masks: SecretMask[],
    timeoutMs?: number,
  ): Promise<SandboxRunResult> {
    try {
      if (kind === 'terminal') {
        const { stdout, stderr } = await this.runDocker([
          'exec', session.containerName, 'sh', '-c', `cd /work && ${code}`,
        ], { timeout: timeoutMs ?? 30_000, maxBuffer: 1024 * 512 });
        return { ok: true, output: this.formatOutput(stdout, stderr, masks) };
      }
      const file = `step-${session.stepCount}.${FILE_EXT[kind]}`;
      await writeFile(join(session.hostDir, file), code, 'utf8');
      const interp = kind === 'python' ? 'python' : 'sh';
      const { stdout, stderr } = await this.runDocker([
        'exec', '-w', '/work', session.containerName, interp, file,
      ], { timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 512 });
      return { ok: true, output: this.formatOutput(stdout, stderr, masks) };
    } catch (error) {
      return this.execError(error, masks);
    }
  }

  private resolveShell(taskId: string, num: number, network: boolean): { session: SandboxSession | undefined; num: number } {
    const key = network ? `${taskId}:net` : taskId;
    return { session: this.sessions.get(key) ?? this.sessions.get(taskId), num };
  }

  private mergeTimeouts(overrides?: Partial<ShellTimeouts>): ShellTimeouts {
    return { ...DEFAULT_SHELL_TIMEOUTS, ...(overrides ?? {}) };
  }

  private async enrichedImageAvailable(): Promise<boolean> {
    const override = process.env.EVA_SANDBOX_IMAGE;
    if (override === '') return false;
    const now = Date.now();
    const ttl = this.enrichedImageCheck?.value ? ENRICHED_CHECK_OK_TTL_MS : ENRICHED_CHECK_FAIL_TTL_MS;
    if (this.enrichedImageCheck && now - this.enrichedImageCheck.checkedAt < ttl) return this.enrichedImageCheck.value;
    const value = await this.runDocker(['image', 'inspect', override ?? ENRICHED_IMAGE, '--format', '{{.Id}}'], {
      timeout: 5000, maxBuffer: 1024 * 16,
    }).then(() => true).catch(() => false);
    this.enrichedImageCheck = { value, checkedAt: now };
    return value;
  }

  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    const taskIds = new Set<string>();
    for (const key of this.sessions.keys()) {
      taskIds.add(key.replace(/:net$/, ''));
    }

    for (const baseId of taskIds) {
      const normalSession = this.sessions.get(baseId);
      const netSession = this.sessions.get(`${baseId}:net`);

      const normalLastUsed = normalSession?.lastUsedAt ?? 0;
      const netLastUsed = netSession?.lastUsedAt ?? 0;
      const lastUsed = Math.max(normalLastUsed, netLastUsed);

      if (now - lastUsed > SESSION_IDLE_TTL_MS) {
        this.logger.log(`reaping idle sandbox sessions for task ${baseId}`);
        await this.release(baseId);
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
