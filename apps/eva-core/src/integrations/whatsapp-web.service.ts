import { Injectable, Logger, Optional } from '@nestjs/common';
import { BrowserScreenshot } from '../browser/browser.types';
import { BrowserService } from '../browser/browser.service';
import { IntegrationsService } from './integrations.service';

const WHATSAPP_WEB_URL = 'https://web.whatsapp.com/';
const WHATSAPP_SERVICE = 'whatsapp_web';
const DEFAULT_SETTLE_MS = 4000;

export type WhatsAppSessionState = 'logged_in' | 'qr_required' | 'loading' | 'unknown';

export interface WhatsAppSessionStatus {
  session_id: string;
  state: WhatsAppSessionState;
  current_url: string | null;
  title?: string;
  screenshot?: BrowserScreenshot;
}

export interface WhatsAppChatPreview {
  chat_name: string;
  preview: string;
  time?: string;
  unread_count?: number;
  raw_lines: string[];
}

export type WhatsAppLatestResult =
  | { ok: true; session: WhatsAppSessionStatus; latest: WhatsAppChatPreview; text: string }
  | { ok: false; reason: 'qr_required' | 'loading' | 'empty' | 'unknown'; session: WhatsAppSessionStatus; text: string };

@Injectable()
export class WhatsAppWebService {
  private readonly logger = new Logger(WhatsAppWebService.name);

  constructor(
    private readonly browser: BrowserService,
    @Optional() private readonly integrations?: IntegrationsService,
  ) {}

  async startSession(orgId: string, taskId?: string): Promise<WhatsAppSessionStatus> {
    const opened = await this.browser.open({
      service: WHATSAPP_SERVICE,
      url: WHATSAPP_WEB_URL,
      task_id: taskId,
      reuse_open: true,
      metadata: { service: WHATSAPP_SERVICE, purpose: 'whatsapp-web' },
    }, orgId);

    await this.browser.wait(opened.id, orgId, this.settleMs());
    const state = await this.detectState(opened.id, orgId);

    if (state === 'logged_in') {
      await this.markConnected(orgId, opened.id).catch((error) => {
        this.logger.warn(`Could not mark WhatsApp integration active: ${(error as Error).message}`);
      });
      return {
        session_id: opened.id,
        state,
        current_url: opened.current_url,
        title: opened.title,
      };
    }

    const screenshot = await this.browser.screenshot(opened.id, orgId);
    return {
      session_id: opened.id,
      state,
      current_url: opened.current_url,
      title: opened.title,
      screenshot,
    };
  }

  async fetchLatestMessage(orgId: string, taskId?: string): Promise<WhatsAppLatestResult> {
    const session = await this.startSession(orgId, taskId);

    if (session.state === 'qr_required') {
      return {
        ok: false,
        reason: 'qr_required',
        session,
        text:
          'Abrí WhatsApp Web, pero falta vincular la sesión. Escanea el QR con tu teléfono; '
          + 'cuando termine, vuelve a pedirme el último mensaje y usaré este perfil local guardado.',
      };
    }

    if (session.state !== 'logged_in') {
      return {
        ok: false,
        reason: session.state === 'loading' ? 'loading' : 'unknown',
        session,
        text:
          'WhatsApp Web abrió, pero todavía no pude confirmar que la sesión esté lista. '
          + 'Espera unos segundos e inténtalo de nuevo.',
      };
    }

    const latest = await this.extractLatestChat(session.session_id, orgId);
    if (!latest) {
      return {
        ok: false,
        reason: 'empty',
        session,
        text:
          'WhatsApp Web está conectado, pero no pude leer un chat reciente en la lista visible. '
          + 'Abre WhatsApp Web una vez o deja visible la lista de chats y vuelve a intentarlo.',
      };
    }

    return {
      ok: true,
      session,
      latest,
      text: this.formatLatest(latest),
    };
  }

  private settleMs(): number {
    const configured = Number(process.env.WHATSAPP_WEB_SETTLE_MS ?? DEFAULT_SETTLE_MS);
    if (!Number.isFinite(configured)) return DEFAULT_SETTLE_MS;
    return Math.min(Math.max(configured, 500), 15000);
  }

  private async markConnected(orgId: string, sessionId: string): Promise<void> {
    if (!this.integrations) return;
    await this.integrations.upsert({
      orgId,
      kind: 'channel',
      provider: 'whatsapp',
      status: 'active',
      label: 'WhatsApp Web',
      config: {
        service: WHATSAPP_SERVICE,
        session_id: sessionId,
        connected_at: new Date().toISOString(),
      },
    });
  }

  private async detectState(sessionId: string, orgId: string): Promise<WhatsAppSessionState> {
    try {
      return await this.browser.evaluate<WhatsAppSessionState>(sessionId, orgId, () => {
        const text = (document.body?.innerText ?? '').toLowerCase();
        const loggedIn = Boolean(
          document.querySelector('#pane-side')
          || document.querySelector('[aria-label="Chat list"]')
          || document.querySelector('[aria-label="Lista de chats"]')
          || document.querySelector('[data-testid="chat-list"]'),
        );
        if (loggedIn) return 'logged_in';

        const hasQrCanvas = Boolean(document.querySelector('canvas'));
        const qrText = /\b(qr|escanea|scan|vincula|linked devices|dispositivos vinculados|usa whatsapp|use whatsapp)\b/i.test(text);
        if (hasQrCanvas || qrText) return 'qr_required';

        if (/\b(loading|cargando|iniciando|connecting|conectando)\b/i.test(text)) return 'loading';
        return 'unknown';
      });
    } catch (error) {
      this.logger.warn(`Could not detect WhatsApp Web state: ${(error as Error).message}`);
      return 'unknown';
    }
  }

  private async extractLatestChat(sessionId: string, orgId: string): Promise<WhatsAppChatPreview | null> {
    try {
      return await this.browser.evaluate<WhatsAppChatPreview | null>(sessionId, orgId, () => {
        const normalize = (value: string) => value.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
        const uniqueLines = (value: string) => {
          const seen = new Set<string>();
          return normalize(value)
            .split('\n')
            .map((line) => normalize(line))
            .filter(Boolean)
            .filter((line) => {
              const key = line.toLowerCase();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
        };
        const isNoise = (line: string) =>
          /^(chats?|chat list|lista de chats|archivados?|archived|comunidades|communities|estados?|status|canales|channels|nuevo chat|new chat|buscar|search)$/i.test(line);
        const timePattern =
          /\b(\d{1,2}:\d{2}|a\.?\s*m\.?|p\.?\s*m\.?|am|pm|ayer|yesterday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|today|hoy|\d{1,2}\/\d{1,2}(\/\d{2,4})?)\b/i;
        const isBadge = (line: string) => /^\d{1,3}$/.test(line);

        const pane =
          document.querySelector('#pane-side')
          || document.querySelector('[aria-label="Chat list"]')
          || document.querySelector('[aria-label="Lista de chats"]')
          || document.body;

        const elements = Array.from(
          pane.querySelectorAll('[role="listitem"], [role="row"], [data-testid="cell-frame-container"], div[tabindex]'),
        );

        for (const element of elements) {
          const lines = uniqueLines((element as HTMLElement).innerText ?? '')
            .filter((line) => !isNoise(line));
          if (lines.length < 2) continue;

          const chatName = lines[0];
          if (!chatName || timePattern.test(chatName) || isBadge(chatName)) continue;

          const time = lines.find((line, index) => index > 0 && timePattern.test(line));
          const unreadRaw = lines.find((line, index) => index > 0 && isBadge(line));
          const preview = [...lines]
            .reverse()
            .find((line) => line !== chatName && line !== time && line !== unreadRaw && !isNoise(line));

          if (!preview) continue;

          return {
            chat_name: chatName,
            preview,
            time,
            unread_count: unreadRaw ? Number(unreadRaw) : undefined,
            raw_lines: lines.slice(0, 8),
          };
        }

        return null;
      });
    } catch (error) {
      this.logger.warn(`Could not extract latest WhatsApp chat: ${(error as Error).message}`);
      return null;
    }
  }

  private formatLatest(latest: WhatsAppChatPreview): string {
    const parts = [
      `Tu último chat visible en WhatsApp es **${latest.chat_name}**`,
      latest.time ? ` (${latest.time})` : '',
      `:\n\n${latest.preview}`,
      latest.unread_count ? `\n\nTienes ${latest.unread_count} mensaje(s) sin leer en ese chat.` : '',
    ];
    return parts.join('');
  }
}
