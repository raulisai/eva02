import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ScheduledJobsRepository } from './scheduled-jobs.repository';
import { ScheduledJob, CreateScheduledJobInput, JobType } from './scheduled-job.types';
import { computeNextRunAt, parseHourFromNl, parseIntervalMinutes } from './cron-utils';

// ── Default mañanero task prompt ──────────────────────────────────────────────
// Runs every morning at 7am. Creates a single task that the agent handles
// via its briefing fast-path, which fetches weather + email + calendar in one pass.
export const MANERO_TASK_INPUT =
  'Buenos días! Dame el briefing matutino: clima de hoy en mi ciudad, '
  + 'mis correos importantes de las últimas 12 horas, y mi agenda de hoy.';

export const DEFAULT_TIMEZONE = 'America/Mexico_City';
export const DEFAULT_MANERO_HOUR = 7;
export const AGENT_AUTONOMY_JOB_KEY = 'agent_intelligence_autonomy';
export const AGENT_AUTONOMY_TASK_INPUT =
  'Ejecuta mantenimiento interno de EVA: expirar input requests, consolidar memorias, generar digest de mejoras y heartbeat si aplica.';

@Injectable()
export class ScheduledJobsService {
  private readonly logger = new Logger(ScheduledJobsService.name);

  constructor(private readonly repo: ScheduledJobsRepository) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(input: CreateScheduledJobInput, orgId: string, userId: string): Promise<ScheduledJob> {
    return this.repo.create({ ...input, org_id: orgId, created_by: userId });
  }

  async list(orgId: string): Promise<ScheduledJob[]> {
    return this.repo.findAll(orgId);
  }

  async getById(id: string, orgId: string): Promise<ScheduledJob> {
    return this.repo.findByIdOrThrow(id, orgId);
  }

  async pause(id: string, orgId: string): Promise<ScheduledJob> {
    await this.repo.findByIdOrThrow(id, orgId);
    return this.repo.setStatus(id, orgId, 'paused');
  }

  async resume(id: string, orgId: string): Promise<ScheduledJob> {
    const job = await this.repo.findByIdOrThrow(id, orgId);
    // Recompute next_run_at from now (it may have drifted while paused)
    const nextRunAt = computeNextRunAt(job);
    await this.repo.setStatus(id, orgId, 'active');
    if (nextRunAt) {
      // Update next_run_at without a dedicated method — recordRun repurposed here
      // is overkill; just create fresh via a direct update via setStatus+extra
      // We'll rely on the scheduler's next tick to pick it up since the status is active.
    }
    return this.repo.findByIdOrThrow(id, orgId);
  }

  async delete(id: string, orgId: string): Promise<void> {
    await this.repo.findByIdOrThrow(id, orgId); // 404 guard
    return this.repo.delete(id, orgId);
  }

  // ── Default jobs ──────────────────────────────────────────────────────────

  /**
   * Seeds the default "mañanero" job for an org if they have no jobs yet.
   * Safe to call multiple times — only creates the default once.
   */
  async ensureDefaultJobs(orgId: string, userId: string): Promise<void> {
    const count = await this.repo.countByOrg(orgId);
    if (count > 0) return;

    await this.create({
      name: 'Mañanero 🌅',
      description: 'Briefing matutino diario: clima, correos importantes y agenda del día.',
      job_type: 'briefing',
      schedule_type: 'cron',
      cron_expr: `0 ${DEFAULT_MANERO_HOUR} * * *`,
      timezone: DEFAULT_TIMEZONE,
      task_input: MANERO_TASK_INPUT,
      payload: { is_default: true },
    }, orgId, userId);

    this.logger.log(`Default mañanero job seeded for org ${orgId}`);
  }

  /**
   * Seeds the internal Agent Intelligence autonomy job for each org. The row is
   * visible in the Jobs dashboard, so operators can pause/resume/audit wakeups.
   */
  async ensureAgentAutonomyJobs(
    owners: Array<{ orgId: string; userId: string }>,
    intervalMinutes: number,
  ): Promise<void> {
    const safeInterval = Math.max(1, Math.round(intervalMinutes));
    await Promise.allSettled(owners.map(async ({ orgId, userId }) => {
      const jobs = await this.repo.findAll(orgId);
      const existing = jobs.find((job) => job.payload?.system_job === AGENT_AUTONOMY_JOB_KEY && job.status !== 'completed');
      if (existing) return;

      await this.create({
        name: 'Autonomía de EVA',
        description: 'Mantenimiento interno: inputs vencidos, consolidación de memoria, self-improvement y heartbeat.',
        job_type: 'custom',
        schedule_type: 'interval',
        interval_minutes: safeInterval,
        timezone: DEFAULT_TIMEZONE,
        task_input: AGENT_AUTONOMY_TASK_INPUT,
        payload: {
          system_job: AGENT_AUTONOMY_JOB_KEY,
          visible_control_plane: true,
        },
      }, orgId, userId);

      this.logger.log(`Agent autonomy job seeded for org ${orgId}`);
    }));
  }

  // ── NL → job creation ─────────────────────────────────────────────────────

  /**
   * Parses a natural-language instruction and creates the corresponding job.
   * Returns the created job and a human-readable summary of what was scheduled.
   */
  async createFromNl(input: string, orgId: string, userId: string): Promise<{ job: ScheduledJob; summary: string }> {
    const type = this.detectJobType(input);
    const schedule = this.parseSchedule(input);
    const taskInput = this.buildTaskInput(input, type);
    const name = this.buildJobName(input, type);

    const job = await this.create({
      name,
      job_type: type,
      ...schedule,
      task_input: taskInput,
      payload: this.extractPayload(input, type),
    }, orgId, userId);

    const summary = this.describeSchedule(job);
    return { job, summary };
  }

  /** Activate (or re-configure) the mañanero, optionally at a custom hour. */
  async activateManero(orgId: string, userId: string, hour?: number): Promise<ScheduledJob> {
    const jobs = await this.repo.findAll(orgId);
    const existing = jobs.find(j => j.job_type === 'briefing' && j.status !== 'completed');

    const h = hour ?? DEFAULT_MANERO_HOUR;
    const cronExpr = `0 ${h} * * *`;

    if (existing) {
      // Pause + delete the old one, create fresh with new hour
      await this.repo.delete(existing.id, orgId);
    }

    return this.create({
      name: 'Mañanero 🌅',
      description: 'Briefing matutino diario: clima, correos importantes y agenda del día.',
      job_type: 'briefing',
      schedule_type: 'cron',
      cron_expr: cronExpr,
      timezone: DEFAULT_TIMEZONE,
      task_input: MANERO_TASK_INPUT,
      payload: { is_default: true },
    }, orgId, userId);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private detectJobType(input: string): JobType {
    // Price beats URL — a product page with a price is price_monitor
    if (/\b(precio|cuesta|vale|product[oa]|amazon|mercadolibre|baj[oó]|suba|alerta\s+de\s+precio)\b/i.test(input)) return 'price_monitor';
    if (/\b(https?:\/\/|url|p[aá]gina|sitio|p[aá]g\.|arriba|disponible|status|down|ca[ií]do)\b/i.test(input)) return 'url_monitor';
    if (/\b(correos?|emails?|mails?|bandeja|inbox)\b/i.test(input)) return 'email_check';
    if (/\b(mañaner[oa]|briefing|resumen\s+matutino|resumen\s+diario|buenos\s+d[ií]as)\b/i.test(input)) return 'briefing';
    return 'custom';
  }

  private parseSchedule(input: string): Pick<CreateScheduledJobInput, 'schedule_type' | 'cron_expr' | 'run_at' | 'interval_minutes' | 'timezone'> {
    const tz = DEFAULT_TIMEZONE;
    const isWeekday = /\b(entre\s+semana|d[ií]as\s+(?:h[aá]biles|laborales)|lunes\s+a\s+viernes)\b/i.test(input);

    // Explicit hour → cron (higher priority than interval signals)
    const hour = parseHourFromNl(input);
    if (hour !== null) {
      const dow = isWeekday ? '1-5' : '*';
      return { schedule_type: 'cron', cron_expr: `0 ${hour} * * ${dow}`, timezone: tz };
    }

    // Sub-day interval: "cada hora", "cada 2 horas", "cada 30 minutos"
    // Note: skip daily (1440) here — use cron for that instead
    const intervalMin = parseIntervalMinutes(input);
    if (intervalMin && intervalMin < 1440) {
      return { schedule_type: 'interval', interval_minutes: intervalMin, timezone: tz };
    }

    // Daily recurrence pattern → cron at 7am default
    const isRecurring = /\b(todos\s+los\s+d[ií]as|cada\s+d[ií]a|diariamente|diario|diaria|todos\s+los\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?))\b/i.test(input);
    if (isRecurring) {
      return { schedule_type: 'cron', cron_expr: `0 7 * * *`, timezone: tz };
    }

    // Default: daily at 7am
    return { schedule_type: 'cron', cron_expr: `0 7 * * *`, timezone: tz };
  }

  private buildTaskInput(input: string, type: JobType): string {
    switch (type) {
      case 'briefing': return MANERO_TASK_INPUT;
      case 'email_check': return 'Revisa mis correos importantes de las últimas 2 horas y dime si hay algo urgente.';
      case 'url_monitor': {
        const urlMatch = input.match(/https?:\/\/[^\s,]+/i);
        const url = urlMatch ? urlMatch[0] : '';
        return url
          ? `Verifica si esta URL responde correctamente: ${url}. Dime el estado HTTP y si está arriba o caída.`
          : 'Verifica si la URL configurada está disponible. Reporta el estado HTTP.';
      }
      case 'price_monitor': {
        const urlMatch = input.match(/https?:\/\/[^\s,]+/i);
        const url = urlMatch ? urlMatch[0] : '';
        return url
          ? `Revisa el precio actual en esta página: ${url}. Dime el precio visible y si ha cambiado.`
          : 'Revisa el precio del producto configurado y repórtame el precio actual.';
      }
      default: {
        // For custom, strip the scheduling part and use the rest as task input
        const stripped = input
          .replace(/\b(todos\s+los\s+días|cada\s+(hora|día|\d+\s*(hora[s]?|minuto[s]?))|a\s+las?\s+\d+([ap]m)?|recuér[d]?ame|avísame|programa[r]?|agenda[r]?)\b/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        return stripped || input;
      }
    }
  }

  private buildJobName(input: string, type: JobType): string {
    const shortInput = input.slice(0, 50).replace(/\s+/g, ' ').trim();
    const typeLabels: Record<JobType, string> = {
      briefing: 'Mañanero 🌅',
      email_check: 'Revisión de correo 📬',
      price_monitor: 'Monitor de precio 💰',
      url_monitor: 'Monitor de URL 🌐',
      custom: shortInput,
    };
    return typeLabels[type];
  }

  private extractPayload(input: string, type: JobType): Record<string, unknown> {
    const urlMatch = input.match(/https?:\/\/[^\s,]+/i);
    const priceMatch = input.match(/\$\s*(\d[\d.,]*)/);

    if (type === 'url_monitor' && urlMatch) return { url: urlMatch[0] };
    if (type === 'price_monitor') {
      return {
        url: urlMatch?.[0] ?? null,
        threshold: priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null,
      };
    }
    return {};
  }

  describeSchedule(job: ScheduledJob): string {
    const tz = job.timezone ?? DEFAULT_TIMEZONE;
    if (job.schedule_type === 'cron' && job.cron_expr) {
      const parts = job.cron_expr.split(' ');
      const h = parts[1];
      const dow = parts[4];
      const timeLabel = h === '*' ? 'cada hora' : `${h}:00`;
      const dayLabel = dow === '*' ? 'todos los días'
        : dow === '1-5' ? 'lunes a viernes'
        : `dow ${dow}`;
      return `"${job.name}" programado a las **${timeLabel}** (${dayLabel}, zona ${tz}).`;
    }
    if (job.schedule_type === 'interval' && job.interval_minutes) {
      const h = Math.floor(job.interval_minutes / 60);
      const m = job.interval_minutes % 60;
      const label = h > 0 ? (m > 0 ? `${h}h ${m}min` : `${h}h`) : `${m}min`;
      return `"${job.name}" programado cada **${label}**.`;
    }
    if (job.schedule_type === 'once' && job.run_at) {
      return `"${job.name}" programado para el **${new Date(job.run_at).toLocaleString('es-MX')}**.`;
    }
    return `"${job.name}" programado.`;
  }
}
