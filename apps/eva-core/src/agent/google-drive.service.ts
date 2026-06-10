import { Injectable, Logger } from '@nestjs/common';
import { IntegrationsService } from '../integrations/integrations.service';
import { GoogleCredential } from '../integrations/integrations.types';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;        // bytes (absent for Google Docs/Sheets/Slides)
  modifiedTime: string; // ISO
  webViewLink?: string;
}

export type DriveQueryMode = 'large_files' | 'folders' | 'recent' | 'general';

export type DriveFetchResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no_credential' | 'token_error' | 'api_error'; error?: string };

interface CachedToken { accessToken: string; expiresAt: number }
const TOKEN_CACHE = new Map<string, CachedToken>();

const FOLDER_MIME = 'application/vnd.google-apps.folder';

@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);

  constructor(private readonly integrations: IntegrationsService) {}

  /**
   * Smart query: detects intent from the user's request and returns the
   * most relevant formatted listing.
   */
  async fetchForQuery(orgId: string, userQuery: string): Promise<DriveFetchResult> {
    const mode = this.detectMode(userQuery);
    const tokenResult = await this.getAccessToken(orgId);
    if (!tokenResult.ok) return { ok: false, reason: tokenResult.reason, error: tokenResult.error };

    const token = tokenResult.token;
    const isCountQuery = /\b(cu[aá]ntos?|cuantos?|how many)\b/i.test(userQuery);
    try {
      switch (mode) {
        case 'large_files': return this.fetchLargeFiles(token);
        case 'folders':     return this.fetchFolders(token, isCountQuery);
        case 'recent':      return this.fetchRecent(token, isCountQuery);
        default:            return this.fetchRecent(token, isCountQuery);
      }
    } catch (err) {
      return { ok: false, reason: 'api_error', error: (err as Error).message };
    }
  }

  // ── Query modes ───────────────────────────────────────────────────────────

  private async fetchLargeFiles(token: string): Promise<DriveFetchResult> {
    const q = "trashed=false and mimeType != 'application/vnd.google-apps.folder'";
    const files = await this.listFiles(token, q, 'quotaBytesUsed desc', 10);
    if (!files.ok) return files;

    const lines = files.items
      .filter(f => f.size !== undefined)
      .map((f, i) => `${i + 1}. **${f.name}** — ${this.fmtSize(f.size!)} — ${this.relativeDate(f.modifiedTime)}`);

    if (lines.length === 0) return { ok: true, text: '📂 No se encontraron archivos grandes en Drive.' };
    return { ok: true, text: `📂 Archivos más pesados en tu Drive:\n\n${lines.join('\n')}` };
  }

  private async fetchFolders(token: string, countOnly = false): Promise<DriveFetchResult> {
    const q = `trashed=false and mimeType = '${FOLDER_MIME}'`;
    const files = await this.listFiles(token, q, 'modifiedTime desc', 50);
    if (!files.ok) return files;

    if (files.items.length === 0) return { ok: true, text: '📂 No se encontraron carpetas en Drive.' };
    if (countOnly) {
      return { ok: true, text: `📂 Tienes **${files.items.length}** carpetas en Drive.` };
    }
    const show = files.items.slice(0, 15);
    const lines = show.map((f, i) => `${i + 1}. 📁 **${f.name}** — modificado ${this.relativeDate(f.modifiedTime)}`);
    const extra = files.items.length > 15 ? `\n_(y ${files.items.length - 15} más)_` : '';
    return { ok: true, text: `📂 Tus carpetas en Drive:\n\n${lines.join('\n')}${extra}` };
  }

  private async fetchRecent(token: string, countOnly = false): Promise<DriveFetchResult> {
    const pageSize = countOnly ? 100 : 10;
    const q = "trashed=false";
    const files = await this.listFiles(token, q, 'modifiedTime desc', pageSize);
    if (!files.ok) return files;

    if (files.items.length === 0) return { ok: true, text: '📂 Drive está vacío o no hay archivos accesibles.' };
    if (countOnly) {
      const dirs = files.items.filter(f => f.mimeType === FOLDER_MIME).length;
      const docs = files.items.length - dirs;
      return {
        ok: true,
        text: `📂 Tu Drive tiene al menos **${files.items.length}** elementos visibles: ${docs} archivo${docs !== 1 ? 's' : ''} y ${dirs} carpeta${dirs !== 1 ? 's' : ''}.`,
      };
    }
    const lines = files.items.map((f, i) => {
      const icon = f.mimeType === FOLDER_MIME ? '📁' : '📄';
      const size = f.size !== undefined ? ` (${this.fmtSize(f.size)})` : '';
      return `${i + 1}. ${icon} **${f.name}**${size} — ${this.relativeDate(f.modifiedTime)}`;
    });
    return { ok: true, text: `📂 Archivos recientes en tu Drive:\n\n${lines.join('\n')}` };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private detectMode(query: string): DriveQueryMode {
    if (/\b(grande|pesad|ocupa|espacio|mbs?|gbs?|mega|giga|ocup)\b/i.test(query)) return 'large_files';
    if (/\b(carpeta|folder)\b/i.test(query)) return 'folders';
    if (/\b(reciente|[uú]ltimo|nuevo|hoy)\b/i.test(query)) return 'recent';
    // "cuantos archivos" / "how many" → list all so we can count
    if (/\b(cu[aá]ntos?|cuantos?|how many)\b/i.test(query)) return 'general';
    return 'general';
  }

  private async listFiles(
    token: string,
    q: string,
    orderBy: string,
    pageSize: number,
  ): Promise<{ ok: true; items: DriveFile[] } | { ok: false; reason: 'api_error'; error: string }> {
    const params = new URLSearchParams({
      q,
      orderBy,
      pageSize: String(pageSize),
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
    });

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      const errMsg = body.error?.message ?? `HTTP ${res.status}`;
      this.logger.warn(`Drive list failed (${res.status}): ${errMsg}`);
      return { ok: false, reason: 'api_error', error: errMsg };
    }

    const body = (await res.json()) as { files?: Array<{ id?: string; name?: string; mimeType?: string; size?: string; modifiedTime?: string; webViewLink?: string }> };
    const items: DriveFile[] = (body.files ?? []).map(f => ({
      id: f.id ?? '',
      name: f.name ?? '(sin nombre)',
      mimeType: f.mimeType ?? '',
      size: f.size ? parseInt(f.size, 10) : undefined,
      modifiedTime: f.modifiedTime ?? '',
      webViewLink: f.webViewLink,
    }));
    return { ok: true, items };
  }

  private async getAccessToken(
    orgId: string,
  ): Promise<{ ok: true; token: string } | { ok: false; reason: 'no_credential' | 'token_error'; error?: string }> {
    const cached = TOKEN_CACHE.get(`drive:${orgId}`);
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
        this.logger.warn(`Drive token refresh failed for org ${orgId}: ${msg}`);
        return { ok: false, reason: 'token_error', error: msg };
      }
      const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
      TOKEN_CACHE.set(`drive:${orgId}`, { accessToken: body.access_token, expiresAt });
      return { ok: true, token: body.access_token };
    } catch (err) {
      return { ok: false, reason: 'token_error', error: (err as Error).message };
    }
  }

  private fmtSize(bytes: number): string {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(1)} MB`;
    if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(0)} KB`;
    return `${bytes} B`;
  }

  private relativeDate(iso: string): string {
    if (!iso) return '';
    try {
      const dt = new Date(iso);
      const diffH = (Date.now() - dt.getTime()) / 3_600_000;
      if (diffH < 1) return 'hace unos minutos';
      if (diffH < 24) return `hace ${Math.floor(diffH)}h`;
      const diffD = Math.floor(diffH / 24);
      if (diffD === 1) return 'ayer';
      if (diffD < 7) return `hace ${diffD} días`;
      return dt.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return iso;
    }
  }
}
