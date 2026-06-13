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
    if (/\b(acci[oó]n(es)?|bolsa|stock|ticker|cotizaci[oó]n|mercado\s+(burs[aá]til|financiero)|nasdaq|nyse|s&p|googl|aapl|tsla|amzn|meta|nflx|msft)\b/i.test(input)) return 'stock_monitor';
    if (/\b(valida[r]?\s+(archivo|fichero|documento|pdf|excel|csv)|verifica[r]?\s+archivo|integridad\s+de\s+archivo|archivo\s+roto|da[ñn]ado)\b/i.test(input)) return 'file_validator';
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

    // Monthly recurrence → first day of month at 8am (reads previous month's data)
    const isMonthly = /\b(cada\s+mes|mensual(mente)?|al\s+final\s+del\s+mes|fin\s+de\s+mes|[uú]ltimo\s+d[ií]a|reporte\s+mensual|informe\s+mensual)\b/i.test(input);
    if (isMonthly) {
      return { schedule_type: 'cron', cron_expr: `0 8 1 * *`, timezone: tz };
    }

    // Weekly recurrence pattern
    const dayMap: Record<string, number> = {
      lunes: 1, martes: 2, 'mi[eé]rcoles': 3, miercoles: 3, jueves: 4,
      viernes: 5, 's[aá]bado': 6, sabado: 6, domingo: 0,
    };
    for (const [day, dow] of Object.entries(dayMap)) {
      if (new RegExp(`\\b(todos\\s+los\\s+)?${day}s?\\b`, 'i').test(input)) {
        return { schedule_type: 'cron', cron_expr: `0 8 * * ${dow}`, timezone: tz };
      }
    }

    // Daily recurrence pattern → cron at 7am default
    const isRecurring = /\b(todos\s+los\s+d[ií]as|cada\s+d[ií]a|diariamente|diario|diaria)\b/i.test(input);
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
      case 'stock_monitor': {
        // Extract ticker symbols (ALL CAPS 1-5 chars) or company names from the input
        const tickerMatch = input.match(/\b([A-Z]{1,5})\b/);
        const companyMap: Record<string, string> = {
          google: 'GOOGL', alphabet: 'GOOGL', apple: 'AAPL', tesla: 'TSLA',
          amazon: 'AMZN', microsoft: 'MSFT', meta: 'META', netflix: 'NFLX',
        };
        let ticker = tickerMatch?.[1] ?? '';
        for (const [name, sym] of Object.entries(companyMap)) {
          if (new RegExp(`\\b${name}\\b`, 'i').test(input)) { ticker = sym; break; }
        }
        const isMonthlyReport = /\b(reporte|informe|resumen|mensual|fin\s+de\s+mes)\b/i.test(input);
        if (isMonthlyReport) {
          return `Genera un informe mensual de la acción ${ticker || 'indicada'}: usa code_execute con yfinance para descargar los datos OHLCV del mes anterior (period="1mo"), calcula precio de apertura, cierre, máximo, mínimo, variación porcentual total, días al alza vs días a la baja, y volumen promedio. También lee el data_log con key "stock:${ticker || 'TARGET'}" para incluir observaciones acumuladas. Presenta el informe con formato claro en español y enviámelo por Telegram si está configurado.`;
        }
        return `Monitoreo diario de la acción ${ticker || 'indicada'}: usa code_execute con yfinance (yf.download("${ticker || 'TICKER'}", period="1d", interval="1d")) para obtener el precio de cierre y la variación porcentual del día. Guarda el resultado en data_log con key "stock:${ticker || 'TICKER'}" y valor JSON {"price": X, "change_pct": Y, "date": "YYYY-MM-DD"}. Si la variación supera el 5% en cualquier dirección, avísame con una nota destacada.`;
      }
      case 'file_validator': {
        return `Valida la integridad y calidad de los archivos indicados: verifica que no estén corruptos o vacíos, que el formato sea el correcto (PDF legible, Excel con hojas, CSV con columnas esperadas, imágenes con dimensiones válidas), y que el contenido tenga sentido (no páginas en blanco, no filas vacías, no valores nulos masivos). Usa code_execute para hacer la validación programática. Reporta qué archivos son válidos, cuáles tienen problemas y qué tipo de problema encontraste. Si algún archivo está roto o incompleto, dime exactamente qué encontraste.`;
      }
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
      stock_monitor: 'Monitor de acciones 📈',
      file_validator: 'Validador de archivos 📁',
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
