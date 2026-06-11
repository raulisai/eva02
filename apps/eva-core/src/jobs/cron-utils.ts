/**
 * Minimal 5-field cron parser + next-run calculator.
 * Supports: * | n | *\/n | a-b | a,b | a-b/n
 * Fields:  minute  hour  dom  month  dow  (0=Sunday)
 * Timezone-aware: uses Intl.DateTimeFormat to decompose dates.
 */

function parseCronField(field: string, min: number, max: number): Set<number> {
  if (field === '*') {
    const s = new Set<number>();
    for (let v = min; v <= max; v++) s.add(v);
    return s;
  }
  const set = new Set<number>();
  for (const token of field.split(',')) {
    if (token.startsWith('*/')) {
      const step = parseInt(token.slice(2), 10);
      for (let v = min; v <= max; v += step) set.add(v);
    } else if (/^\d+\/\d+$/.test(token)) {
      const [start, step] = token.split('/').map(Number);
      for (let v = start; v <= max; v += step) set.add(v);
    } else if (token.includes('/')) {
      const [range, stepStr] = token.split('/');
      const step = parseInt(stepStr, 10);
      const [lo, hi] = range.includes('-') ? range.split('-').map(Number) : [Number(range), max];
      for (let v = lo; v <= hi; v += step) set.add(v);
    } else if (token.includes('-')) {
      const [lo, hi] = token.split('-').map(Number);
      for (let v = lo; v <= hi; v++) set.add(v);
    } else {
      const n = parseInt(token, 10);
      if (!Number.isNaN(n)) set.add(n);
    }
  }
  return set;
}

const DOW_SHORT: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function tzComponents(d: Date, tz: string) {
  // hour12:false makes hour go 0-23 (Intl uses 0-23 range)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(d);

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0';
  const hour = parseInt(get('hour'), 10) % 24; // "24" → 0 on midnight edge
  return {
    minute: parseInt(get('minute'), 10),
    hour,
    day: parseInt(get('day'), 10),
    month: parseInt(get('month'), 10),
    dow: DOW_SHORT[get('weekday')] ?? 0,
  };
}

/**
 * Returns the next Date on which the cron expression fires, strictly after `from`.
 * Throws if no match is found within a year (indicates a malformed expression).
 */
export function nextCronDate(expr: string, tz: string, from: Date): Date {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression (need 5 fields): "${expr}"`);

  const [mf, hf, domf, monthf, dowf] = fields;
  const minuteSet = parseCronField(mf, 0, 59);
  const hourSet   = parseCronField(hf, 0, 23);
  const domSet    = parseCronField(domf, 1, 31);
  const monthSet  = parseCronField(monthf, 1, 12);
  const dowSet    = parseCronField(dowf, 0, 6);

  // Advance to the next whole minute after `from`
  const cursor = new Date(from.getTime() + 60_000);
  cursor.setSeconds(0, 0);

  // Bounded search: up to 1 year of minutes (527,040 iterations ≈ sub-ms)
  for (let i = 0; i < 527_040; i++) {
    const c = tzComponents(cursor, tz);
    if (
      monthSet.has(c.month)
      && domSet.has(c.day)
      && dowSet.has(c.dow)
      && hourSet.has(c.hour)
      && minuteSet.has(c.minute)
    ) {
      return new Date(cursor);
    }
    cursor.setTime(cursor.getTime() + 60_000);
  }
  throw new Error(`No valid date found for cron "${expr}" within a year`);
}

export interface ScheduleSpec {
  schedule_type: 'cron' | 'once' | 'interval';
  cron_expr?: string | null;
  run_at?: string | null;
  interval_minutes?: number | null;
  timezone: string;
}

/**
 * Computes the next ISO datetime at which a job should run.
 * Returns null for one-time jobs after their run, or if the spec is incomplete.
 */
export function computeNextRunAt(spec: ScheduleSpec, from: Date = new Date()): string | null {
  if (spec.schedule_type === 'cron' && spec.cron_expr) {
    try {
      return nextCronDate(spec.cron_expr, spec.timezone, from).toISOString();
    } catch {
      return null;
    }
  }
  if (spec.schedule_type === 'interval' && spec.interval_minutes) {
    return new Date(from.getTime() + spec.interval_minutes * 60_000).toISOString();
  }
  if (spec.schedule_type === 'once' && spec.run_at) {
    // After first run, there is no next run
    return null;
  }
  return null;
}

/**
 * Parses a simple hour from natural language like "7am", "las 8", "a las 10am".
 * Returns 24h hour (0-23) or null if not detected.
 */
export function parseHourFromNl(input: string): number | null {
  const m = input.match(/\ba\s+las?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i)
    ?? input.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const period = (m[3] ?? '').toLowerCase().replace(/\./g, '');
  if (period === 'pm' && hour < 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return null;
  return hour;
}

/**
 * Parses an interval in minutes from natural language.
 * "cada hora" → 60, "cada 2 horas" → 120, "cada 30 minutos" → 30, etc.
 */
export function parseIntervalMinutes(input: string): number | null {
  const m = input.match(/\bcada\s+(\d+)\s*(hora[s]?|h\b)/i);
  if (m) return parseInt(m[1], 10) * 60;
  if (/\bcada\s+hora\b/i.test(input)) return 60;

  const m2 = input.match(/\bcada\s+(\d+)\s*(minuto[s]?|min\b)/i);
  if (m2) return parseInt(m2[1], 10);

  const m3 = input.match(/\bcada\s+(\d+)\s*(día[s]?|dia[s]?|d\b)/i);
  if (m3) return parseInt(m3[1], 10) * 1440;
  if (/\b(todos\s+los\s+días|cada\s+día|diariamente)\b/i.test(input)) return 1440;

  return null;
}
