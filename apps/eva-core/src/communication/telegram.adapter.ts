import { Injectable } from '@nestjs/common';
import { ChannelSendResult } from './communication.types';

@Injectable()
export class TelegramAdapter {
  private get token() {
    return process.env.TELEGRAM_BOT_TOKEN;
  }

  verifyWebhookSecret(secret?: string): boolean {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    return Boolean(expected) && secret === expected;
  }

  async sendMessage(target: Record<string, unknown>, text: string): Promise<ChannelSendResult> {
    const chatId = String(target['chat_id'] ?? '');
    if (!chatId) return { ok: false, error: 'Missing Telegram chat_id' };
    if (!this.token) return { ok: true, skipped: true, externalMessageId: null };

    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      return { ok: false, error: await response.text() };
    }

    const body = (await response.json()) as { result?: { message_id?: number } };
    return { ok: true, externalMessageId: body.result?.message_id ? String(body.result.message_id) : null };
  }
}
