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
  latest_from_me?: boolean;
  raw_lines: string[];
}

export interface WhatsAppChatRowSnapshot {
  lines: string[];
  titles: string[];
  aria_labels: string[];
  text?: string;
}

export type WhatsAppLatestResult =
  | { ok: true; session: WhatsAppSessionStatus; latest: WhatsAppChatPreview; text: string }
  | { ok: false; reason: 'qr_required' | 'loading' | 'empty' | 'unknown'; session: WhatsAppSessionStatus; text: string };

export type WhatsAppUnreadResult =
  | { ok: true; session: WhatsAppSessionStatus; unread: WhatsAppChatPreview[]; text: string }
  | { ok: false; reason: 'qr_required' | 'loading' | 'unknown'; session: WhatsAppSessionStatus; unread: []; text: string };

export type WhatsAppUnansweredResult =
  | {
    ok: true;
    session: WhatsAppSessionStatus;
    pending: WhatsAppChatPreview[];
    answered: WhatsAppChatPreview[];
    text: string;
  }
  | {
    ok: false;
    reason: 'qr_required' | 'loading' | 'unknown';
    session: WhatsAppSessionStatus;
    pending: [];
    answered: [];
    text: string;
  };

const normalizeWhatsAppText = (value: string) => value.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
const uniqueWhatsAppTexts = (values: Array<string | null | undefined>) => {
  const seen = new Set<string>();
  return values
    .map((value) => normalizeWhatsAppText(String(value ?? '')))
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};
const isWhatsAppNoise = (line: string) =>
  /^(chats?|chat list|lista de chats|archivados?|archived|comunidades|communities|estados?|status|canales|channels|nuevo chat|new chat|buscar|search)$/i.test(line);
const isWhatsAppBadge = (line: string) => /^\d{1,3}$/.test(line);
const isWhatsAppUnreadLabel = (line: string) =>
  /^(?:\d{1,3}\s+)?(?:unread messages?|mensajes? sin leer)$/i.test(line);
const isWhatsAppSenderMarker = (line: string) => /^(?:\(you\)|you|t[uú]|yo|me|usted|vos):?$/i.test(line);
const hasWhatsAppOutgoingMarker = (line: string) =>
  isWhatsAppSenderMarker(line) || /^(?:\(you\)|you|t[uú]|yo)\s*:?\s+\S/i.test(line);
const isWhatsAppTimeLine = (line: string) =>
  /^(?:\d{1,2}:\d{2}(?:\s*(?:a\.?\s*m\.?|p\.?\s*m\.?|am|pm))?|ayer|yesterday|hoy|today|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(line);

function isLikelyWhatsAppChatName(line: string): boolean {
  if (!line || line.length > 90) return false;
  if (isWhatsAppNoise(line) || isWhatsAppBadge(line) || isWhatsAppTimeLine(line)) return false;
  if (isWhatsAppUnreadLabel(line) || isWhatsAppSenderMarker(line)) return false;
  if (/\b(unread messages?|mensajes? sin leer|typing|escribiendo|online|en l[ií]nea)\b/i.test(line)) return false;
  return true;
}

function parseUnreadCount(values: string[]): number | undefined {
  for (const value of values) {
    const match = value.match(/\b(\d{1,3})\s+(?:unread messages?|mensajes? sin leer)\b/i);
    if (match) return Number(match[1]);
  }
  const badge = values.find((value) => isWhatsAppBadge(value));
  return badge ? Number(badge) : undefined;
}

function cleanPreviewCandidate(value: string): string {
  return normalizeWhatsAppText(value)
    .replace(/^(?:\(you\)|you|t[uú]|yo|me)\s*:?\s*/i, '')
    .trim();
}

export function parseWhatsAppChatRows(rows: WhatsAppChatRowSnapshot[]): WhatsAppChatPreview[] {
  return rows
    .map((row): WhatsAppChatPreview | null => {
      const lines = uniqueWhatsAppTexts(row.lines);
      const titles = uniqueWhatsAppTexts(row.titles);
      const ariaLabels = uniqueWhatsAppTexts(row.aria_labels);
      const allSignals = uniqueWhatsAppTexts([...titles, ...lines, ...ariaLabels, row.text]);
      const chatName = titles.find(isLikelyWhatsAppChatName) ?? lines.find(isLikelyWhatsAppChatName);
      if (!chatName) return null;

      const time = [...lines, ...titles].find(isWhatsAppTimeLine);
      const unreadCount = parseUnreadCount(allSignals);
      const latestFromMe = uniqueWhatsAppTexts([...lines, ...titles, ...ariaLabels])
        .some(hasWhatsAppOutgoingMarker);
      const chatKey = chatName.toLowerCase();
      const timeKey = time?.toLowerCase();
      const preview = uniqueWhatsAppTexts([...lines, ...titles])
        .map(cleanPreviewCandidate)
        .filter((line) => {
          const key = line.toLowerCase();
          if (!line || key === chatKey || key === timeKey) return false;
          if (isWhatsAppNoise(line) || isWhatsAppBadge(line) || isWhatsAppTimeLine(line)) return false;
          if (isWhatsAppUnreadLabel(line) || isWhatsAppSenderMarker(line)) return false;
          return true;
        })
        .reverse()[0];

      if (!preview && !unreadCount) return null;
      const chat: WhatsAppChatPreview = {
        chat_name: chatName,
        preview: preview ?? 'Vista previa no disponible en la lista visible',
        latest_from_me: latestFromMe,
        raw_lines: lines.slice(0, 10),
      };
      if (time) chat.time = time;
      if (unreadCount) chat.unread_count = unreadCount;
      return chat;
    })
    .filter((chat): chat is WhatsAppChatPreview => chat !== null);
}

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

    const screenshot = await this.captureQrScreenshot(opened.id, orgId, taskId);
    return {
      session_id: opened.id,
      state,
      current_url: opened.current_url,
      title: opened.title,
      screenshot,
    };
  }

  async validateSession(orgId: string, taskId?: string): Promise<WhatsAppSessionStatus> {
    return this.startSession(orgId, taskId);
  }

  async captureSessionScreenshot(orgId: string, taskId?: string): Promise<WhatsAppSessionStatus> {
    const session = await this.startSession(orgId, taskId);
    if (session.state !== 'logged_in') return session;
    return {
      ...session,
      screenshot: await this.browser.screenshot(session.session_id, orgId),
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

  async fetchUnreadMessages(orgId: string, taskId?: string): Promise<WhatsAppUnreadResult> {
    const session = await this.startSession(orgId, taskId);

    if (session.state === 'qr_required') {
      return {
        ok: false,
        reason: 'qr_required',
        session,
        unread: [],
        text:
          'Abrí WhatsApp Web, pero falta vincular la sesión. Escanea el QR con tu teléfono; '
          + 'cuando termine, vuelve a pedirme los mensajes sin leer.',
      };
    }

    if (session.state !== 'logged_in') {
      return {
        ok: false,
        reason: session.state === 'loading' ? 'loading' : 'unknown',
        session,
        unread: [],
        text:
          'WhatsApp Web abrió, pero todavía no pude confirmar que la sesión esté lista. '
          + 'Espera unos segundos e inténtalo de nuevo.',
      };
    }

    const unread = (await this.extractVisibleChats(session.session_id, orgId))
      .filter((chat) => (chat.unread_count ?? 0) > 0);

    return {
      ok: true,
      session,
      unread,
      text: this.formatUnread(unread),
    };
  }

  async fetchUnansweredMessages(orgId: string, taskId?: string): Promise<WhatsAppUnansweredResult> {
    const session = await this.startSession(orgId, taskId);

    if (session.state === 'qr_required') {
      return {
        ok: false,
        reason: 'qr_required',
        session,
        pending: [],
        answered: [],
        text:
          'Abrí WhatsApp Web, pero falta vincular la sesión. Escanea el QR con tu teléfono; '
          + 'cuando termine, vuelve a pedirme los mensajes sin responder.',
      };
    }

    if (session.state !== 'logged_in') {
      return {
        ok: false,
        reason: session.state === 'loading' ? 'loading' : 'unknown',
        session,
        pending: [],
        answered: [],
        text:
          'WhatsApp Web abrió, pero todavía no pude confirmar que la sesión esté lista. '
          + 'Espera unos segundos e inténtalo de nuevo.',
      };
    }

    const chats = await this.extractVisibleChats(session.session_id, orgId);
    const pending = chats.filter((chat) => !chat.latest_from_me);
    const answered = chats.filter((chat) => chat.latest_from_me);

    return {
      ok: true,
      session,
      pending,
      answered,
      text: this.formatUnanswered(pending, answered),
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

  private async captureQrScreenshot(sessionId: string, orgId: string, taskId?: string): Promise<BrowserScreenshot> {
    const qr = await this.browser.evaluate<{ image_base64: string; mime_type: string } | null>(sessionId, orgId, () => {
      const canvases = Array.from(document.querySelectorAll('canvas'))
        .filter((canvas) => canvas.width >= 120 && canvas.height >= 120)
        .sort((a, b) => (b.width * b.height) - (a.width * a.height));
      const canvas = canvases[0];
      if (!canvas) return null;
      const dataUrl = canvas.toDataURL('image/png');
      const [, base64] = dataUrl.split(',');
      if (!base64) return null;
      return { image_base64: base64, mime_type: 'image/png' };
    }).catch((error) => {
      this.logger.warn(`Could not extract WhatsApp QR canvas: ${(error as Error).message}`);
      return null;
    });

    if (qr) {
      return {
        id: `${sessionId}-whatsapp-qr`,
        org_id: orgId,
        session_id: sessionId,
        task_id: taskId ?? null,
        image_base64: qr.image_base64,
        mime_type: qr.mime_type,
        created_at: new Date().toISOString(),
      };
    }

    return this.browser.screenshot(sessionId, orgId);
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
    const chats = await this.extractVisibleChats(sessionId, orgId);
    return chats[0] ?? null;
  }

  private async extractVisibleChats(sessionId: string, orgId: string): Promise<WhatsAppChatPreview[]> {
    try {
      const rows = await this.browser.evaluate<WhatsAppChatRowSnapshot[]>(sessionId, orgId, () => {
        const normalize = (value: string) => value.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
        const unique = (values: string[]) => {
          const seen = new Set<string>();
          return values
            .map((line) => normalize(line))
            .filter(Boolean)
            .filter((line) => {
              const key = line.toLowerCase();
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
        };
        const pane =
          document.querySelector('#pane-side')
          || document.querySelector('[aria-label="Chat list"]')
          || document.querySelector('[aria-label="Lista de chats"]')
          || document.body;

        const elements = Array.from(pane.querySelectorAll('[role="listitem"], [role="row"], [data-testid="cell-frame-container"]'))
          .filter((element) => {
            const htmlElement = element as HTMLElement;
            const rect = htmlElement.getBoundingClientRect();
            const text = normalize(htmlElement.innerText ?? '');
            return text && rect.height >= 32 && rect.width >= 160;
          });

        return elements.slice(0, 30).map((element) => {
          const htmlElement = element as HTMLElement;
          const labelled = Array.from(htmlElement.querySelectorAll('[aria-label]'))
            .map((node) => (node as HTMLElement).getAttribute('aria-label') ?? '');
          const titled = Array.from(htmlElement.querySelectorAll('[title]'))
            .map((node) => (node as HTMLElement).getAttribute('title') ?? '');
          const text = normalize(htmlElement.innerText ?? '');
          return {
            text,
            lines: unique(text.split('\n')),
            titles: unique(titled),
            aria_labels: unique([htmlElement.getAttribute('aria-label') ?? '', ...labelled]),
          };
        });
      });
      return parseWhatsAppChatRows(rows);
    } catch (error) {
      this.logger.warn(`Could not extract latest WhatsApp chat: ${(error as Error).message}`);
      return [];
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

  private formatUnread(unread: WhatsAppChatPreview[]): string {
    if (unread.length === 0) {
      return 'WhatsApp Web está conectado. No encontré chats con mensajes sin leer en la lista visible.';
    }

    const lines = unread.slice(0, 8).map((chat) => {
      const count = chat.unread_count ? `${chat.unread_count} sin leer` : 'sin leer';
      const time = chat.time ? ` (${chat.time})` : '';
      return `- **${chat.chat_name}**${time}: ${chat.preview} — ${count}`;
    });
    return `Chats visibles con mensajes sin leer en WhatsApp:\n\n${lines.join('\n')}`;
  }

  private formatUnanswered(pending: WhatsAppChatPreview[], answered: WhatsAppChatPreview[]): string {
    const formatLine = (chat: WhatsAppChatPreview) => {
      const time = chat.time ? ` (${chat.time})` : '';
      const unread = chat.unread_count ? ` — ${chat.unread_count} sin leer` : '';
      return `- **${chat.chat_name}**${time}: ${chat.preview}${unread}`;
    };

    if (pending.length === 0) {
      const answeredSummary = answered.length
        ? `\n\nYa contestados visibles:\n${answered.slice(0, 5).map(formatLine).join('\n')}`
        : '';
      return `WhatsApp Web está conectado. No encontré chats visibles sin responder.${answeredSummary}`;
    }

    const pendingLines = pending.slice(0, 8).map(formatLine);
    const answeredLines = answered.slice(0, 5).map(formatLine);
    return [
      'Chats visibles sin responder en WhatsApp:',
      '',
      pendingLines.join('\n'),
      answeredLines.length ? '\nYa contestados visibles:' : '',
      answeredLines.length ? answeredLines.join('\n') : '',
    ].filter(Boolean).join('\n');
  }
}
