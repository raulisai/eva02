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

export type WhatsAppContactMessagesResult =
  | {
      ok: true;
      session: WhatsAppSessionStatus;
      contact: string;
      messages: string[];
      text: string;
    }
  | {
      ok: false;
      reason: 'qr_required' | 'loading' | 'contact_not_found' | 'empty' | 'unknown';
      session: WhatsAppSessionStatus;
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
      await this.browser.saveProfileState(opened.id, orgId).catch((err) => {
        this.logger.error(`Failed to auto-save WhatsApp profile state: ${err.message}`);
      });
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

  async fetchContactMessages(orgId: string, contactName: string, taskId?: string): Promise<WhatsAppContactMessagesResult> {
    const session = await this.startSession(orgId, taskId);

    if (session.state === 'qr_required') {
      return {
        ok: false,
        reason: 'qr_required',
        session,
        text:
          'Abrí WhatsApp Web, pero falta vincular la sesión. Escanea el QR con tu teléfono; '
          + `cuando termine, vuelve a pedirme los mensajes de ${contactName}.`,
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

    const { ok: opened, actualContactName } = await this.selectContact(session.session_id, orgId, contactName);
    
    // Always capture a screenshot of what we found/did!
    const screenshot = await this.browser.screenshot(session.session_id, orgId);
    const updatedSession = { ...session, screenshot };

    if (!opened || !actualContactName) {
      return {
        ok: false,
        reason: 'contact_not_found',
        session: updatedSession,
        text: `No pude encontrar ningún contacto similar a **${contactName}** en WhatsApp. Te adjunto una captura de la pantalla actual para que lo verifiques.`,
      };
    }

    const messages = await this.extractOpenChatMessages(session.session_id, orgId);
    
    const exactMatch = actualContactName.toLowerCase().trim() === contactName.toLowerCase().trim();
    const matchNotice = exactMatch 
      ? `Mensajes recientes de **${actualContactName}**:` 
      : `No encontré un contacto exacto para "${contactName}". Abrí el chat de **${actualContactName}** (coincidencia más cercana encontrada en la búsqueda):`;

    const text = messages.length === 0
      ? `${matchNotice}\n\nNo encontré mensajes visibles en esta conversación. Te adjunto una captura de pantalla.`
      : `${matchNotice}\n\n` + messages.map((msg) => msg.replace(/\n+/g, ' ')).join('\n');

    return {
      ok: true,
      session: updatedSession,
      contact: actualContactName,
      messages,
      text,
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

  private async selectContact(sessionId: string, orgId: string, contactName: string): Promise<{ ok: boolean; actualContactName: string | null }> {
    const contactLower = contactName.toLowerCase().trim();

    // 1. Check if we are already in the chat with this contact
    const alreadyOpen = await this.browser.evaluate<{ open: boolean; actualContactName: string | null }, string>(sessionId, orgId, (contactNameLower) => {
      function isMatch(chatName: string | null | undefined, query: string | null | undefined): boolean {
        if (!chatName || !query) return false;
        const clean = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        const c = clean(chatName);
        const q = clean(query);
        if (c.includes(q)) return true;
        const cWords = c.split(/\s+/);
        const qWords = q.split(/\s+/);
        const allMatched = qWords.every((qw: string) => cWords.some((cw: string) => cw.startsWith(qw)));
        if (allMatched) return true;
        const initials = cWords.map((w: string) => w[0]).join('');
        if (initials.startsWith(q)) return true;
        return false;
      }

      const header = document.querySelector('header');
      if (header) {
        const titleEl = header.querySelector('[dir="auto"], span[title]');
        const headerText = titleEl ? (titleEl.getAttribute('title') || titleEl.getAttribute('aria-label') || titleEl.textContent || '') : header.innerText || '';
        if (isMatch(headerText, contactNameLower)) {
          return { open: true, actualContactName: headerText };
        }
      }
      return { open: false, actualContactName: null };
    }, contactLower);

    if (alreadyOpen.open) {
      return { ok: true, actualContactName: alreadyOpen.actualContactName };
    }

    // 2. Try to click on the contact if it's already visible in the list
    const clickedVisible = await this.browser.evaluate<{ clicked: boolean; actualContactName: string | null }, string>(sessionId, orgId, (contactNameLower) => {
      function isMatch(chatName: string | null | undefined, query: string | null | undefined): boolean {
        if (!chatName || !query) return false;
        const clean = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        const c = clean(chatName);
        const q = clean(query);
        if (c.includes(q)) return true;
        const cWords = c.split(/\s+/);
        const qWords = q.split(/\s+/);
        const allMatched = qWords.every((qw: string) => cWords.some((cw: string) => cw.startsWith(qw)));
        if (allMatched) return true;
        const initials = cWords.map((w: string) => w[0]).join('');
        if (initials.startsWith(q)) return true;
        return false;
      }

      const pane = document.querySelector('#pane-side') || document.querySelector('[aria-label="Chat list"]') || document.querySelector('[aria-label="Lista de chats"]') || document.body;
      const elements = Array.from(pane.querySelectorAll('[role="listitem"], [role="row"], [data-testid="cell-frame-container"]'));
      for (const el of elements) {
        const titleEl = el.querySelector('[title], [aria-label]');
        const chatName = titleEl ? (titleEl.getAttribute('title') || titleEl.getAttribute('aria-label') || el.textContent || '') : el.textContent || '';
        if (isMatch(chatName, contactNameLower)) {
          (el as HTMLElement).click();
          return { clicked: true, actualContactName: chatName };
        }
      }
      return { clicked: false, actualContactName: null };
    }, contactLower);

    if (clickedVisible.clicked) {
      await this.browser.wait(sessionId, orgId, 1500); // Wait for chat to open
      return { ok: true, actualContactName: clickedVisible.actualContactName };
    }

    // 3. Search for the contact using clickNow + typeCharacters
    const searchSelectors = [
      'div[contenteditable="true"][data-tab="3"]',
      'div.lexical-rich-text-input div[contenteditable="true"]',
      '[data-testid="chat-list-search"]',
      '[aria-label="Search or start new chat"]',
      '[aria-label="Buscar o empezar un nuevo chat"]',
      '[aria-label="Search"]',
      '[aria-label="Buscar"]'
    ];

    let typed = false;
    for (const selector of searchSelectors) {
      try {
        await this.browser.clickNow(sessionId, orgId, selector, { timeout: 1500 });
        await this.browser.evaluate(sessionId, orgId, (sel) => {
          const el = document.querySelector(sel) as HTMLElement;
          if (el) {
            el.focus();
            if (el.getAttribute('contenteditable') === 'true') {
              el.innerText = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }
        }, selector);
        await this.browser.typeCharacters(sessionId, orgId, contactName, 80);
        typed = true;
        break;
      } catch (e) {
        // ignore and try next
      }
    }

    if (!typed) {
      return { ok: false, actualContactName: null };
    }

    await this.browser.wait(sessionId, orgId, 2000); // Wait for search results to load

    // Click the matching search result
    const clickedSearchResult = await this.browser.evaluate<{ clicked: boolean; actualContactName: string | null }, string>(sessionId, orgId, (contactNameLower) => {
      function isMatch(chatName: string | null | undefined, query: string | null | undefined): boolean {
        if (!chatName || !query) return false;
        const clean = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
        const c = clean(chatName);
        const q = clean(query);
        if (c.includes(q)) return true;
        const cWords = c.split(/\s+/);
        const qWords = q.split(/\s+/);
        const allMatched = qWords.every((qw: string) => cWords.some((cw: string) => cw.startsWith(qw)));
        if (allMatched) return true;
        const initials = cWords.map((w: string) => w[0]).join('');
        if (initials.startsWith(q)) return true;
        return false;
      }

      const pane = document.querySelector('#pane-side') || document.querySelector('[aria-label="Chat list"]') || document.querySelector('[aria-label="Lista de chats"]') || document.body;
      const elements = Array.from(pane.querySelectorAll('[role="listitem"], [role="row"], [data-testid="cell-frame-container"]'));
      
      // Try matching
      for (const el of elements) {
        const titleEl = el.querySelector('[title], [aria-label]');
        const chatName = titleEl ? (titleEl.getAttribute('title') || titleEl.getAttribute('aria-label') || el.textContent || '') : el.textContent || '';
        if (isMatch(chatName, contactNameLower)) {
          (el as HTMLElement).click();
          return { clicked: true, actualContactName: chatName };
        }
      }
      
      // Fallback to first search result
      if (elements.length > 0) {
        const el = elements[0];
        (el as HTMLElement).click();
        const titleEl = el.querySelector('[title], [aria-label]');
        const chatName = titleEl ? (titleEl.getAttribute('title') || titleEl.getAttribute('aria-label') || el.textContent || '') : el.textContent || '';
        return { clicked: true, actualContactName: chatName };
      }
      
      return { clicked: false, actualContactName: null };
    }, contactLower);

    if (clickedSearchResult.clicked) {
      await this.browser.wait(sessionId, orgId, 1500); // Wait for chat to open
      return { ok: true, actualContactName: clickedSearchResult.actualContactName };
    }

    // Fallback: If full search yielded nothing, try searching for the first word/token of the query
    const firstWord = contactName.split(/\s+/)[0];
    if (firstWord && firstWord.length > 1 && firstWord.toLowerCase() !== contactLower) {
      let typedFirst = false;
      for (const selector of searchSelectors) {
        try {
          await this.browser.clickNow(sessionId, orgId, selector, { timeout: 1500 });
          await this.browser.evaluate(sessionId, orgId, (sel) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (el) {
              el.focus();
              if (el.getAttribute('contenteditable') === 'true') {
                el.innerText = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
          }, selector);
          await this.browser.typeCharacters(sessionId, orgId, firstWord, 80);
          typedFirst = true;
          break;
        } catch (e) {
          // ignore and try next
        }
      }

      if (typedFirst) {
        await this.browser.wait(sessionId, orgId, 2000);

        const secondAttempt = await this.browser.evaluate<{ clicked: boolean; actualContactName: string | null }, string>(sessionId, orgId, (contactNameLower) => {
          function isMatch(chatName: string | null | undefined, query: string | null | undefined): boolean {
            if (!chatName || !query) return false;
            const clean = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
            const c = clean(chatName);
            const q = clean(query);
            if (c.includes(q)) return true;
            const cWords = c.split(/\s+/);
            const qWords = q.split(/\s+/);
            const allMatched = qWords.every(qw => cWords.some(cw => cw.startsWith(qw)));
            if (allMatched) return true;
            const initials = cWords.map(w => w[0]).join('');
            if (initials.startsWith(q)) return true;
            return false;
          }

          const pane = document.querySelector('#pane-side') || document.querySelector('[aria-label="Chat list"]') || document.querySelector('[aria-label="Lista de chats"]') || document.body;
          const elements = Array.from(pane.querySelectorAll('[role="listitem"], [role="row"], [data-testid="cell-frame-container"]'));
          
          for (const el of elements) {
            const titleEl = el.querySelector('[title], [aria-label]');
            const chatName = titleEl ? (titleEl.getAttribute('title') || titleEl.getAttribute('aria-label') || el.textContent || '') : el.textContent || '';
            if (isMatch(chatName, contactNameLower)) {
              (el as HTMLElement).click();
              return { clicked: true, actualContactName: chatName };
            }
          }

          if (elements.length > 0) {
            const el = elements[0];
            (el as HTMLElement).click();
            const titleEl = el.querySelector('[title], [aria-label]');
            const chatName = titleEl ? (titleEl.getAttribute('title') || titleEl.getAttribute('aria-label') || el.textContent || '') : el.textContent || '';
            return { clicked: true, actualContactName: chatName };
          }

          return { clicked: false, actualContactName: null };
        }, contactLower);

        if (secondAttempt.clicked) {
          await this.browser.wait(sessionId, orgId, 1500);
          return { ok: true, actualContactName: secondAttempt.actualContactName };
        }
      }
    }

    return { ok: false, actualContactName: null };
  }

  private async extractOpenChatMessages(sessionId: string, orgId: string): Promise<string[]> {
    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
      const messages = await this.browser.evaluate<string[]>(sessionId, orgId, () => {
        const main = document.querySelector('#main');
        if (!main) return [];

        const selectors = [
          '#main .message-in',
          '#main .message-out',
          '#main [data-testid="msg-container"]',
          '#main [data-pre-plain-text]',
          '#main .copyable-text',
          '#main span.selectable-text'
        ];

        let messageElements: Element[] = [];
        for (const selector of selectors) {
          const els = Array.from(main.querySelectorAll(selector));
          if (els.length > 0) {
            messageElements = els;
            break;
          }
        }

        const results: string[] = [];
        const seenTexts = new Set<string>();

        for (const el of messageElements) {
          const prePlainText = el.getAttribute('data-pre-plain-text');
          const textEl = el.querySelector('span.selectable-text, .copyable-text span, .copyable-text') as HTMLElement;
          let text = '';
          if (textEl) {
            text = textEl.innerText.trim();
          } else {
            text = (el as HTMLElement).innerText ? (el as HTMLElement).innerText.trim() : '';
          }
          
          if (!text) continue;

          let msgLine = '';
          if (prePlainText) {
            msgLine = `${prePlainText.trim()} ${text}`;
          } else {
            const isIncoming = el.classList.contains('message-in') || el.closest('.message-in') !== null;
            const sender = isIncoming ? 'Contacto' : 'Tú';
            msgLine = `[${sender}]: ${text}`;
          }

          if (!seenTexts.has(msgLine)) {
            results.push(msgLine);
            seenTexts.add(msgLine);
          }
        }
        
        return results;
      });

      if (messages.length > 0) {
        return messages.slice(-15);
      }

      await this.browser.wait(sessionId, orgId, 300);
    }

    return [];
  }

  private formatContactMessages(contactName: string, messages: string[]): string {
    if (messages.length === 0) {
      return `Abrí el chat de **${contactName}**, pero no encontré mensajes visibles en la conversación.`;
    }
    const list = messages.map((msg) => msg.replace(/\n+/g, ' ')).join('\n');
    return `Mensajes recientes de **${contactName}** en WhatsApp:\n\n${list}`;
  }
}
