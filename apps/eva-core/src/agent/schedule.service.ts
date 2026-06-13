import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

// ── Types ────────────────────────────────────────────────────────────────────

export type EventType = 'one_time' | 'recurring';
export type EventSource = 'manual' | 'wear' | 'voice' | 'google_calendar' | 'pattern';
export type LocationType = 'home' | 'work' | 'gym' | 'restaurant' | 'transit' | 'other';

export type RecurrenceDays = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface Recurrence {
  days: RecurrenceDays[];
  time: string;          // HH:mm
  until?: string;        // YYYY-MM-DD
}

export interface ScheduleEvent {
  id: string;
  org_id: string;
  title: string;
  description?: string;
  event_type: EventType;
  scheduled_date?: string;   // YYYY-MM-DD  (one_time)
  scheduled_time?: string;   // HH:mm       (one_time)
  recurrence?: Recurrence;   // (recurring)
  duration_min: number;
  location_label?: string;
  location_type?: LocationType;
  source: EventSource;
  external_id?: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateScheduleEventInput {
  title: string;
  description?: string;
  event_type: EventType;
  scheduled_date?: string;
  scheduled_time?: string;
  recurrence?: Recurrence;
  duration_min?: number;
  location_label?: string;
  location_type?: LocationType;
  source?: EventSource;
  external_id?: string;
  metadata?: Record<string, unknown>;
}

export interface KnownPlace {
  id: string;
  org_id: string;
  label: string;
  address?: string;
  lat?: number;
  lng?: number;
  radius_m: number;
  visit_count: number;
  last_visit?: string;
  typical_days?: string[];
  typical_time?: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface LocationReport {
  lat: number;
  lng: number;
  accuracy_m?: number;
  recorded_at?: string;
}

const DAYS_ES: Record<RecurrenceDays, string> = {
  mon: 'Lun', tue: 'Mar', wed: 'Mié', thu: 'Jue',
  fri: 'Vie', sat: 'Sáb', sun: 'Dom',
};

// Haversine distance in meters
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(private readonly db: DatabaseService) {}

  // ── Events CRUD ────────────────────────────────────────────────────────────

  async createEvent(orgId: string, input: CreateScheduleEventInput): Promise<ScheduleEvent> {
    const { data, error } = await this.db.admin
      .from('schedule_events')
      .insert({
        org_id: orgId,
        title: input.title,
        description: input.description ?? null,
        event_type: input.event_type,
        scheduled_date: input.scheduled_date ?? null,
        scheduled_time: input.scheduled_time ?? null,
        recurrence: input.recurrence ?? null,
        duration_min: input.duration_min ?? 60,
        location_label: input.location_label ?? null,
        location_type: input.location_type ?? null,
        source: input.source ?? 'manual',
        external_id: input.external_id ?? null,
        metadata: input.metadata ?? {},
      })
      .select()
      .single();

    if (error) throw new Error(`schedule_events.create: ${error.message}`);
    return data as ScheduleEvent;
  }

  async deleteEvent(orgId: string, eventId: string): Promise<void> {
    await this.db.admin
      .from('schedule_events')
      .delete()
      .eq('id', eventId)
      .eq('org_id', orgId);
  }

  /**
   * Returns events for the next `days` days (one-time) plus all active
   * recurring events, merged and sorted by effective datetime.
   */
  async getUpcomingEvents(orgId: string, days = 7): Promise<ScheduleEvent[]> {
    const today = new Date();
    const maxDate = new Date(today.getTime() + days * 86_400_000);

    const [oneTimeRes, recurringRes] = await Promise.all([
      this.db.admin
        .from('schedule_events')
        .select('*')
        .eq('org_id', orgId)
        .eq('event_type', 'one_time')
        .gte('scheduled_date', today.toISOString().slice(0, 10))
        .lte('scheduled_date', maxDate.toISOString().slice(0, 10))
        .order('scheduled_date', { ascending: true })
        .order('scheduled_time', { ascending: true }),
      this.db.admin
        .from('schedule_events')
        .select('*')
        .eq('org_id', orgId)
        .eq('event_type', 'recurring'),
    ]);

    const oneTime = (oneTimeRes.data ?? []) as ScheduleEvent[];
    const recurring = this.expandRecurring(
      (recurringRes.data ?? []) as ScheduleEvent[],
      today,
      maxDate,
    );

    return [...oneTime, ...recurring].sort(this.sortByDatetime);
  }

  /**
   * Formats upcoming events as a compact text block for soul context injection.
   * Returns null when there are no events.
   */
  async formatUpcomingForSoul(orgId: string, days = 7): Promise<string | null> {
    const events = await this.getUpcomingEvents(orgId, days);
    if (events.length === 0) return null;

    const todayStr = new Date().toISOString().slice(0, 10);
    const tomorrowStr = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const lines = events.map(e => {
      const dateStr = e.scheduled_date ?? this.nextOccurrence(e.recurrence!, new Date())?.toISOString().slice(0, 10);
      const dateLabel =
        dateStr === todayStr ? 'Hoy'
        : dateStr === tomorrowStr ? 'Mañana'
        : new Date(dateStr + 'T12:00:00').toLocaleDateString('es-MX', {
            weekday: 'short', day: 'numeric', month: 'short',
          });

      const timeLabel = e.scheduled_time
        ? e.scheduled_time.slice(0, 5)
        : e.recurrence?.time ?? '';

      const loc = e.location_label ? ` @ ${e.location_label}` : '';
      const recurring = e.event_type === 'recurring' ? ' ↻' : '';
      return `- ${dateLabel}${timeLabel ? ` ${timeLabel}` : ''}${recurring}: ${e.title}${loc}`;
    });

    return lines.join('\n');
  }

  // ── Known Places ───────────────────────────────────────────────────────────

  async upsertPlace(orgId: string, label: string, data: Partial<KnownPlace>): Promise<KnownPlace> {
    const { data: row, error } = await this.db.admin
      .from('known_places')
      .upsert(
        { org_id: orgId, label, ...data },
        { onConflict: 'org_id,label' },
      )
      .select()
      .single();

    if (error) throw new Error(`known_places.upsert: ${error.message}`);
    return row as KnownPlace;
  }

  async getPlaces(orgId: string): Promise<KnownPlace[]> {
    const { data } = await this.db.admin
      .from('known_places')
      .select('*')
      .eq('org_id', orgId)
      .order('visit_count', { ascending: false });
    return (data ?? []) as KnownPlace[];
  }

  async getPlace(orgId: string, label: string): Promise<KnownPlace | null> {
    const { data } = await this.db.admin
      .from('known_places')
      .select('*')
      .eq('org_id', orgId)
      .eq('label', label)
      .maybeSingle();
    return data as KnownPlace | null;
  }

  async getLatestLocation(orgId: string): Promise<LocationReport | null> {
    const { data, error } = await this.db.admin
      .from('location_visits')
      .select('lat, lng, accuracy_m, recorded_at')
      .eq('org_id', orgId)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return {
      lat: data.lat,
      lng: data.lng,
      accuracy_m: data.accuracy_m ?? undefined,
      recorded_at: data.recorded_at,
    };
  }


  /**
   * Records a GPS location report from the watch.
   * Matches against known places (geofence), increments visit_count,
   * and saves the raw visit for pattern analysis.
   */
  async recordLocation(orgId: string, report: LocationReport): Promise<KnownPlace | null> {
    const places = await this.getPlaces(orgId);
    let matchedPlace: KnownPlace | null = null;

    for (const place of places) {
      if (!place.lat || !place.lng) continue;
      const dist = haversineMeters(report.lat, report.lng, place.lat, place.lng);
      if (dist <= place.radius_m) {
        matchedPlace = place;
        break;
      }
    }

    // Save raw visit
    const ts = report.recorded_at ?? new Date().toISOString();
    await this.db.admin.from('location_visits').insert({
      org_id: orgId,
      lat: report.lat,
      lng: report.lng,
      accuracy_m: report.accuracy_m ?? null,
      place_id: matchedPlace?.id ?? null,
      place_label: matchedPlace?.label ?? null,
      recorded_at: ts,
    });

    // Increment visit_count + update last_visit on matched place
    if (matchedPlace) {
      await this.db.admin
        .from('known_places')
        .update({
          visit_count: matchedPlace.visit_count + 1,
          last_visit: ts,
        })
        .eq('id', matchedPlace.id)
        .eq('org_id', orgId);
    }

    return matchedPlace;
  }

  // ── Upsert from Google Calendar (optional enrichment) ─────────────────────

  /**
   * Syncs Google Calendar events into local schedule_events.
   * Uses external_id to avoid duplicates. Returns count of new events.
   */
  async upsertFromGoogleCalendar(
    orgId: string,
    events: Array<{
      externalId: string;
      title: string;
      description?: string;
      startDatetime: string;
      endDatetime?: string;
      location?: string;
    }>,
  ): Promise<number> {
    let count = 0;
    for (const ev of events) {
      const dateStr = ev.startDatetime.slice(0, 10);
      const timeStr = ev.startDatetime.length > 10 ? ev.startDatetime.slice(11, 16) : undefined;
      const durationMin = ev.endDatetime
        ? Math.round((new Date(ev.endDatetime).getTime() - new Date(ev.startDatetime).getTime()) / 60_000)
        : 60;

      // Upsert by external_id
      const { error } = await this.db.admin
        .from('schedule_events')
        .upsert(
          {
            org_id: orgId,
            title: ev.title,
            description: ev.description ?? null,
            event_type: 'one_time',
            scheduled_date: dateStr,
            scheduled_time: timeStr ?? null,
            duration_min: durationMin,
            location_label: ev.location ?? null,
            source: 'google_calendar',
            external_id: ev.externalId,
            metadata: {},
          },
          { onConflict: 'org_id,external_id', ignoreDuplicates: false },
        );

      if (!error) count++;
    }
    return count;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private expandRecurring(
    events: ScheduleEvent[],
    from: Date,
    to: Date,
  ): ScheduleEvent[] {
    const expanded: ScheduleEvent[] = [];
    const todayName = this.isoToDayName(from);
    const days: RecurrenceDays[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    for (const ev of events) {
      if (!ev.recurrence) continue;
      const { days: recDays, time, until } = ev.recurrence;
      if (until && until < from.toISOString().slice(0, 10)) continue;

      let cursor = new Date(from);
      while (cursor <= to) {
        const dayName = days[cursor.getDay()] as RecurrenceDays;
        if (recDays.includes(dayName)) {
          expanded.push({
            ...ev,
            event_type: 'recurring',
            scheduled_date: cursor.toISOString().slice(0, 10),
            scheduled_time: time,
          });
        }
        cursor = new Date(cursor.getTime() + 86_400_000);
      }
    }

    return expanded;
  }

  private nextOccurrence(recurrence: Recurrence, from: Date): Date | null {
    const days: RecurrenceDays[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    let cursor = new Date(from);
    for (let i = 0; i < 14; i++) {
      const dayName = days[cursor.getDay()] as RecurrenceDays;
      if (recurrence.days.includes(dayName)) return cursor;
      cursor = new Date(cursor.getTime() + 86_400_000);
    }
    return null;
  }

  private isoToDayName(date: Date): RecurrenceDays {
    return (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as RecurrenceDays[])[date.getDay()];
  }

  private sortByDatetime(a: ScheduleEvent, b: ScheduleEvent): number {
    const aKey = `${a.scheduled_date ?? ''}${a.scheduled_time ?? ''}`;
    const bKey = `${b.scheduled_date ?? ''}${b.scheduled_time ?? ''}`;
    return aKey.localeCompare(bKey);
  }
}
