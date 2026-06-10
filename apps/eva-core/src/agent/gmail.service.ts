import { Injectable, Logger } from '@nestjs/common';
import { IntegrationsService } from '../integrations/integrations.service';
import { GoogleCredential } from '../integrations/integrations.types';

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  isRead: boolean;
}

export type GmailFetchResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no_credential' | 'token_error' | 'api_error' | 'empty'; error?: string };

interface CachedToken { accessToken: string; expiresAt: number }
const TOKEN_CACHE = new Map<string, CachedToken>();

// All invisible / zero-width chars used as email preview-text stuffers.
// Written as explicit \uXXXX to avoid invisible characters in source code.
const INVISIBLE_CHARS_RE = /[\u00AD\u034F\u180E\u200B\u200C\u200D\u200E\u200F\u2028\u2029\u202A\u202B\u202C\u202D\u202E\u2060\u2061\u2062\u2063\u2064\u206A\u206B\u206C\u206D\u206E\u206F\uFEFF]/g;

@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);

  constructor(private readonly integrations: IntegrationsService) {}

  async isConnected(orgId: string): Promise<boolean> {
    const r = await this.getAccessToken(orgId);
    return r.ok;
  }

  /** Fetch the latest inbox messages. */
  async fetchLatest(orgId: string, limit = 5): Promise<GmailFetchResult> {
    const tokenResult = await this.getAccessToken(orgId);
    if (!tokenResult.ok) return { ok: false, reason: tokenResult.reason, error: tokenResult.error };
    return this.listAndFormat(tokenResult.token, { labelIds: 'INBOX', limit }, '');
  }

  /**
   * Search Gmail using a query string (Gmail search syntax, e.g. "from:santander").
   * Returns the matching messages formatted the same way as fetchLatest.
   */
  async fetchSearch(orgId: string, gmailQuery: string, limit = 5): Promise<GmailFetchResult> {
    const tokenResult = await this.getAccessToken(orgId);
    if (!tokenResult.ok) return { ok: false, reason: tokenResult.reason, error: tokenResult.error };
    return this.listAndFormat(tokenResult.token, { q: gmailQuery, limit }, gmailQuery);
  }

  /**
   * Two-stage search: tries recent emails first (last 90 days), then falls back
   * to all-time if nothing found. On fallback it annotates the result so the
   * user knows the match came from older history.
   */
  async fetchSearchWithFallback(orgId: string, query: string, limit = 5): Promise<GmailFetchResult> {
    const tokenResult = await this.getAccessToken(orgId);
    if (!tokenResult.ok) return { ok: false, reason: tokenResult.reason, error: tokenResult.error };

    const recent = await this.listAndFormat(
      tokenResult.token,
      { q: `${query} newer_than:90d`, limit },
      query,
    );

    if (recent.ok) return recent;
    if (recent.reason !== 'empty') return recent;

    const allTime = await this.listAndFormat(tokenResult.token, { q: query, limit }, query);
    if (!allTime.ok) return allTime;

    // Strip the default header and prefix with context message
    const body = allTime.text.replace(/^📬[^\n]+\n\n/, '');
    return {
      ok: true,
      text: `📬 No encontré en los últimos 3 meses, pero sí en correos más antiguos:\n\n${body}`,
    };
  }

  /** Legacy compat — returns null on any failure (used by older callers). */
  async formatLatestForResponse(orgId: string, limit = 5): Promise<string | null> {
    const r = await this.fetchLatest(orgId, limit);
    return r.ok ? r.text : null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async listAndFormat(
    token: string,
    params: { q?: string; labelIds?: string; limit?: number },
    searchLabel: string,
  ): Promise<GmailFetchResult> {
    const limit = params.limit ?? 5;
    const qs = new URLSearchParams({ maxResults: String(limit) });
    if (params.labelIds) qs.set('labelIds', params.labelIds);
    if (params.q) qs.set('q', params.q);

    try {
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${qs}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!listRes.ok) {
        const body = (await listRes.json().catch(() => ({}))) as { error?: { message?: string } };
        const errMsg = body.error?.message ?? `HTTP ${listRes.status}`;
        this.logger.warn(`Gmail list failed (${listRes.status}): ${errMsg}`);
        return { ok: false, reason: 'api_error', error: errMsg };
      }

      const listBody = (await listRes.json()) as { messages?: Array<{ id: string; threadId: string }> };
      const ids = listBody.messages ?? [];
      if (ids.length === 0) return { ok: false, reason: 'empty' };

      const messages = await Promise.all(
        ids.map(({ id, threadId }) =>
          fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
            .then(r => r.ok ? r.json() : null)
            .then((msg: GmailApiMessage | null) => msg ? this.toMessage(id, threadId, msg) : null)
            .catch(() => null),
        ),
      );

      const valid = messages.filter((m): m is GmailMessage => m !== null);
      if (valid.length === 0) return { ok: false, reason: 'empty' };

      const lines = valid.map((m, i) => {
        const unread = m.isRead ? '' : ' \u{1F535}';
        const date = this.relativeDate(m.date);
        const snippet = this.cleanSnippet(m.snippet);
        return `${i + 1}.${unread} **${m.subject || '(sin asunto)'}**\n   De: ${m.from} — ${date}\n   ${snippet}`;
      });

      const header = searchLabel
        ? `\u{1F4EC} Resultados para _${searchLabel}_:\n\n`
        : `\u{1F4EC} Últimos ${valid.length} correos en tu bandeja:\n\n`;

      return { ok: true, text: `${header}${lines.join('\n\n')}` };
    } catch (err) {
      this.logger.warn('Gmail fetch error', err);
      return { ok: false, reason: 'api_error', error: (err as Error).message };
    }
  }

  private async getAccessToken(
    orgId: string,
  ): Promise<{ ok: true; token: string } | { ok: false; reason: 'no_credential' | 'token_error'; error?: string }> {
    const cached = TOKEN_CACHE.get(`gmail:${orgId}`);
    if (cached && cached.expiresAt > Date.now() + 60_000) return { ok: true, token: cached.accessToken };

    const secret = await this.integrations.getSecret(orgId, 'credential', 'google');
    if (!secret) return { ok: false, reason: 'no_credential' };

    let credential: GoogleCredential;
    try {
      credential = JSON.parse(secret) as GoogleCredential;
    } catch {
      return { ok: false, reason: 'no_credential', error: 'Credencial almacenada no es JSON válido' };
    }
    if (!credential.client_id || !credential.client_secret || !credential.refresh_token) {
      return { ok: false, reason: 'no_credential', error: 'Faltan client_id, client_secret o refresh_token' };
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
        access_token?: string; expires_in?: number; error?: string; error_description?: string;
      };
      if (!body.access_token) {
        const msg = body.error_description ?? body.error ?? 'Token exchange failed';
        this.logger.warn(`Gmail token refresh failed for org ${orgId}: ${msg}`);
        return { ok: false, reason: 'token_error', error: msg };
      }
      const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
      TOKEN_CACHE.set(`gmail:${orgId}`, { accessToken: body.access_token, expiresAt });
      return { ok: true, token: body.access_token };
    } catch (err) {
      this.logger.warn('Gmail token refresh network error', err);
      return { ok: false, reason: 'token_error', error: (err as Error).message };
    }
  }

  private toMessage(id: string, threadId: string, msg: GmailApiMessage): GmailMessage {
    const headers = msg.payload?.headers ?? [];
    const get = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
    const labelIds = msg.labelIds ?? [];
    return {
      id, threadId,
      from: get('From'),
      subject: get('Subject'),
      date: get('Date'),
      snippet: msg.snippet ?? '',
      isRead: !labelIds.includes('UNREAD'),
    };
  }

  private cleanSnippet(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(INVISIBLE_CHARS_RE, '')
      .replace(/ /g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private relativeDate(dateStr: string): string {
    if (!dateStr) return '';
    try {
      const dt = new Date(dateStr);
      const diffMs = Date.now() - dt.getTime();
      const diffH = Math.floor(diffMs / 3_600_000);
      if (diffH < 1) return 'hace unos minutos';
      if (diffH < 24) return `hace ${diffH}h`;
      const diffD = Math.floor(diffH / 24);
      if (diffD === 1) return 'ayer';
      if (diffD < 7) return `hace ${diffD} días`;
      return dt.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    } catch {
      return dateStr;
    }
  }
}

interface GmailApiMessage {
  id?: string; threadId?: string; labelIds?: string[]; snippet?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}
