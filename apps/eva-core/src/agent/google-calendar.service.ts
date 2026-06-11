import { Injectable, Logger } from '@nestjs/common';
import { IntegrationsService } from '../integrations/integrations.service';
import { GoogleCredential } from '../integrations/integrations.types';

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;       // ISO datetime or date
  end: string;
  allDay: boolean;
  attendees: string[]; // email addresses
  htmlLink?: string;
}

export interface CreateEventInput {
  summary: string;
  description?: string;
  location?: string;
  startDateTime: string;  // ISO datetime (YYYY-MM-DDTHH:mm:ss)
  endDateTime: string;
  attendees?: string[];   // email addresses
  timeZone?: string;      // IANA timezone, default: 'America/Mexico_City'
}

// Token cache (in-process): avoids refreshing on every call within the same session.
interface CachedToken { accessToken: string; expiresAt: number }
const TOKEN_CACHE = new Map<string, CachedToken>();

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);

  constructor(private readonly integrations: IntegrationsService) {}

  /**
   * Returns upcoming events for the next `days` days (default 7).
   * Returns [] if Google credential is not configured.
   */
  async getUpcomingEvents(orgId: string, days = 7): Promise<CalendarEvent[]> {
    const token = await this.getAccessToken(orgId);
    if (!token) return [];

    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '25',
    });

    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!res.ok) {
        const body = await res.text();
        this.logger.warn(`Google Calendar list failed (${res.status}): ${body.slice(0, 200)}`);
        return [];
      }

      const body = (await res.json()) as { items?: GoogleCalendarApiEvent[] };
      return (body.items ?? []).map(this.toCalendarEvent);
    } catch (err) {
      this.logger.warn('Google Calendar fetch error', err);
      return [];
    }
  }

  /**
   * Creates a new event on the user's primary calendar.
   * Returns the created event or null on failure.
   */
  async createEvent(orgId: string, input: CreateEventInput): Promise<CalendarEvent | null> {
    const token = await this.getAccessToken(orgId);
    if (!token) return null;

    const tz = input.timeZone ?? 'America/Mexico_City';
    const body = {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startDateTime, timeZone: tz },
      end: { dateTime: input.endDateTime, timeZone: tz },
      attendees: (input.attendees ?? []).map(email => ({ email })),
    };

    try {
      const res = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (!res.ok) {
        const errBody = await res.text();
        this.logger.warn(`Google Calendar create failed (${res.status}): ${errBody.slice(0, 200)}`);
        return null;
      }

      const created = (await res.json()) as GoogleCalendarApiEvent;
      return this.toCalendarEvent(created);
    } catch (err) {
      this.logger.warn('Google Calendar create error', err);
      return null;
    }
  }

  /**
   * Updates an existing calendar event. Only the fields present in `patch` are changed.
   * Returns the updated event or null on failure.
   */
  async updateEvent(orgId: string, eventId: string, patch: Partial<CreateEventInput>): Promise<CalendarEvent | null> {
    const token = await this.getAccessToken(orgId);
    if (!token) return null;

    const tz = patch.timeZone ?? 'America/Mexico_City';
    const body: Record<string, unknown> = {};
    if (patch.summary) body.summary = patch.summary;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.location !== undefined) body.location = patch.location;
    if (patch.startDateTime) body.start = { dateTime: patch.startDateTime, timeZone: tz };
    if (patch.endDateTime) body.end = { dateTime: patch.endDateTime, timeZone: tz };
    if (patch.attendees) body.attendees = patch.attendees.map(email => ({ email }));

    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        this.logger.warn(`Google Calendar update failed (${res.status})`);
        return null;
      }
      const updated = (await res.json()) as GoogleCalendarApiEvent;
      return this.toCalendarEvent(updated);
    } catch (err) {
      this.logger.warn('Google Calendar update error', err);
      return null;
    }
  }

  /**
   * Deletes a single calendar event by ID.
   * Returns { ok: true } on success or { ok: false, error } on failure.
   * MUST be protected by Approval Engine before calling.
   */
  async deleteEvent(orgId: string, eventId: string): Promise<{ ok: boolean; error?: string }> {
    const token = await this.getAccessToken(orgId);
    if (!token) return { ok: false, error: 'No hay credencial de Google configurada' };

    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status === 204 || res.ok) return { ok: true };
      const body = await res.text();
      this.logger.warn(`Google Calendar delete failed (${res.status}): ${body.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      this.logger.warn('Google Calendar delete error', err);
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Returns true if this org has an active Google credential configured.
   */
  async isConnected(orgId: string): Promise<boolean> {
    const token = await this.getAccessToken(orgId);
    return Boolean(token);
  }

  /**
   * Formats upcoming events as a compact human-readable block for soul context.
   * Returns null if no events or calendar not connected.
   */
  async formatUpcomingForSoul(orgId: string, days = 7): Promise<string | null> {
    const events = await this.getUpcomingEvents(orgId, days);
    if (events.length === 0) return null;

    const today = new Date().toDateString();
    const tomorrow = new Date(Date.now() + 86_400_000).toDateString();

    const lines = events.map(e => {
      const dt = new Date(e.start);
      const dateLabel =
        dt.toDateString() === today ? 'Hoy'
        : dt.toDateString() === tomorrow ? 'Mañana'
        : dt.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });

      const timeLabel = e.allDay
        ? '(todo el día)'
        : dt.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

      const who = e.attendees.length > 0 ? ` — con ${e.attendees.slice(0, 2).join(', ')}` : '';
      return `- ${dateLabel} ${timeLabel}: ${e.summary}${who}`;
    });

    return lines.join('\n');
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async getAccessToken(orgId: string): Promise<string | null> {
    // Check in-process cache first
    const cached = TOKEN_CACHE.get(orgId);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.accessToken;
    }

    const secret = await this.integrations.getSecret(orgId, 'credential', 'google');
    if (!secret) return null;

    let credential: GoogleCredential;
    try {
      credential = JSON.parse(secret) as GoogleCredential;
    } catch {
      this.logger.warn(`Invalid Google credential JSON for org ${orgId}`);
      return null;
    }

    if (!credential.client_id || !credential.client_secret || !credential.refresh_token) {
      return null;
    }

    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: credential.client_id,
          client_secret: credential.client_secret,
          refresh_token: credential.refresh_token,
          grant_type: 'refresh_token',
        }),
      });

      const body = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
      };

      if (!body.access_token) {
        this.logger.warn(`Google token refresh failed for org ${orgId}: ${body.error ?? 'unknown'}`);
        return null;
      }

      const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
      TOKEN_CACHE.set(orgId, { accessToken: body.access_token, expiresAt });
      return body.access_token;
    } catch (err) {
      this.logger.warn(`Google token refresh error for org ${orgId}`, err);
      return null;
    }
  }

  private toCalendarEvent(raw: GoogleCalendarApiEvent): CalendarEvent {
    const allDay = Boolean(raw.start?.date);
    return {
      id: raw.id ?? '',
      summary: raw.summary ?? '(sin título)',
      description: raw.description,
      location: raw.location,
      start: raw.start?.dateTime ?? raw.start?.date ?? '',
      end: raw.end?.dateTime ?? raw.end?.date ?? '',
      allDay,
      attendees: (raw.attendees ?? []).map(a => a.email).filter(Boolean) as string[],
      htmlLink: raw.htmlLink,
    };
  }
}

// ── Google API types (minimal) ────────────────────────────────────────────────
interface GoogleCalendarApiEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; displayName?: string }>;
  htmlLink?: string;
}
