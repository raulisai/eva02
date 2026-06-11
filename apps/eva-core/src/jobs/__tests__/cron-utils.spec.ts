import {
  nextCronDate,
  computeNextRunAt,
  parseHourFromNl,
  parseIntervalMinutes,
} from '../cron-utils';

describe('parseHourFromNl', () => {
  it.each([
    ['a las 7am', 7],
    ['a las 8', 8],
    ['a las 10pm', 22],
    ['las 3 pm', 15],
    ['7am', 7],
    ['12am', 0],
    ['12pm', 12],
    ['a las 7:30am', 7],
  ])('parses "%s" → %i', (input, expected) => {
    expect(parseHourFromNl(input)).toBe(expected);
  });

  it('returns null for no match', () => {
    expect(parseHourFromNl('recuérdame mañana')).toBeNull();
  });
});

describe('parseIntervalMinutes', () => {
  it.each([
    ['cada hora', 60],
    ['cada 2 horas', 120],
    ['cada 30 minutos', 30],
    ['cada 90 min', 90],
    ['cada 1 día', 1440],
    ['todos los días', 1440],
    ['cada día', 1440],
  ])('parses "%s" → %i', (input, expected) => {
    expect(parseIntervalMinutes(input)).toBe(expected);
  });

  it('returns null for no match', () => {
    expect(parseIntervalMinutes('recuérdame')).toBeNull();
  });
});

describe('nextCronDate', () => {
  const TZ = 'America/Mexico_City'; // UTC-6

  it('finds next run for "0 7 * * *" (daily 7am)', () => {
    // Use a fixed UTC time that is 6:00am in Mexico City (12:00 UTC)
    const from = new Date('2024-01-15T12:00:00Z'); // 6:00am MX
    const next = nextCronDate('0 7 * * *', TZ, from);
    // Next 7am MX = 13:00 UTC same day
    expect(next.toISOString()).toBe('2024-01-15T13:00:00.000Z');
  });

  it('wraps to next day if current time is past the cron hour', () => {
    const from = new Date('2024-01-15T14:00:00Z'); // 8:00am MX — after 7am
    const next = nextCronDate('0 7 * * *', TZ, from);
    // Next day 7am MX = 2024-01-16T13:00:00Z
    expect(next.toISOString()).toBe('2024-01-16T13:00:00.000Z');
  });

  it('handles weekday filter (1-5)', () => {
    // 2024-01-13 is Saturday UTC → MX = Saturday too
    const from = new Date('2024-01-13T14:00:00Z'); // Saturday 8am MX
    const next = nextCronDate('0 7 * * 1-5', TZ, from);
    // Next weekday is Monday 2024-01-15
    expect(next.toISOString()).toBe('2024-01-15T13:00:00.000Z');
  });

  it('throws on invalid expression', () => {
    expect(() => nextCronDate('bad expr', TZ, new Date())).toThrow();
  });
});

describe('computeNextRunAt', () => {
  it('returns ISO string for cron', () => {
    const from = new Date('2024-01-15T12:00:00Z');
    const result = computeNextRunAt({
      schedule_type: 'cron',
      cron_expr: '0 7 * * *',
      timezone: 'America/Mexico_City',
    }, from);
    expect(result).toBe('2024-01-15T13:00:00.000Z');
  });

  it('returns offset for interval', () => {
    const from = new Date('2024-01-15T12:00:00Z');
    const result = computeNextRunAt({
      schedule_type: 'interval',
      interval_minutes: 30,
      timezone: 'UTC',
    }, from);
    expect(result).toBe('2024-01-15T12:30:00.000Z');
  });

  it('returns null for once (no next run)', () => {
    const result = computeNextRunAt({
      schedule_type: 'once',
      run_at: '2024-01-15T12:00:00Z',
      timezone: 'UTC',
    });
    expect(result).toBeNull();
  });

  it('returns null for incomplete spec', () => {
    const result = computeNextRunAt({ schedule_type: 'cron', timezone: 'UTC' });
    expect(result).toBeNull();
  });
});
