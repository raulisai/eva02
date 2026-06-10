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

interface CachedToken { accessToken: string; expiresAt: number }
const TOKEN_CACHE = new Map<string, CachedToken>();

@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);

  constructor(private readonly integrations: IntegrationsService) {}

  async isConnected(orgId: string): Promise<boolean> {
    return Boolean(await this.getAccessToken(orgId));
  }

  /**
   * Returns the N most recent inbox messages.
   */
  async getLatestMessages(orgId: string, limit = 5): Promise<GmailMessage[]> {
    const token = await this.getAccessToken(orgId);
    if (!token) return [];

    try {
      // List recent message IDs
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&labelIds=INBOX`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!listRes.ok) {
        this.logger.warn(`Gmail list failed (${listRes.status})`);
        return [];
      }
      const listBody = (await listRes.json()) as { messages?: Array<{ id: string; threadId: string }> };
      const ids = listBody.messages ?? [];
      if (ids.length === 0) return [];

      // Fetch each message in parallel (metadata only — no full body)
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

      return messages.filter((m): m is GmailMessage => m !== null);
    } catch (err) {
      this.logger.warn('Gmail fetch error', err);
      return [];
    }
  }

  /**
   * Formats the latest inbox messages as readable text for EVA to relay.
   */
  async formatLatestForResponse(orgId: string, limit = 5): Promise<string | null> {
    const messages = await this.getLatestMessages(orgId, limit);
    if (messages.length === 0) return null;

    const lines = messages.map((m, i) => {
      const unread = m.isRead ? '' : ' 🔵';
      const date = this.relativeDate(m.date);
      return `${i + 1}. ${unread}**${m.subject || '(sin asunto)'}**\n   De: ${m.from} — ${date}\n   ${m.snippet}`;
    });

    return `📬 Últimos ${messages.length} correos en tu bandeja:\n\n${lines.join('\n\n')}`;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async getAccessToken(orgId: string): Promise<string | null> {
    const cached = TOKEN_CACHE.get(`gmail:${orgId}`);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

    const secret = await this.integrations.getSecret(orgId, 'credential', 'google');
    if (!secret) return null;

    let credential: GoogleCredential;
    try {
      credential = JSON.parse(secret) as GoogleCredential;
    } catch {
      return null;
    }
    if (!credential.client_id || !credential.client_secret || !credential.refresh_token) return null;

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
      const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
      if (!body.access_token) {
        this.logger.warn(`Gmail token refresh failed: ${body.error ?? 'unknown'}`);
        return null;
      }
      const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
      TOKEN_CACHE.set(`gmail:${orgId}`, { accessToken: body.access_token, expiresAt });
      return body.access_token;
    } catch (err) {
      this.logger.warn('Gmail token refresh error', err);
      return null;
    }
  }

  private toMessage(id: string, threadId: string, msg: GmailApiMessage): GmailMessage {
    const headers = msg.payload?.headers ?? [];
    const get = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
    const labelIds = msg.labelIds ?? [];
    return {
      id,
      threadId,
      from: get('From'),
      subject: get('Subject'),
      date: get('Date'),
      snippet: msg.snippet ?? '',
      isRead: !labelIds.includes('UNREAD'),
    };
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

// ── Gmail API types (minimal) ────────────────────────────────────────────────
interface GmailApiMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
  };
}
