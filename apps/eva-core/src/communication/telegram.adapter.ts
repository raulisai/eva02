import { Injectable } from '@nestjs/common';
import { SecretCipher } from '../common/secret-cipher';
import { ChannelSendResult } from './communication.types';

@Injectable()
export class TelegramAdapter {
  private get envToken() {
    return process.env.TELEGRAM_BOT_TOKEN;
  }

  /**
   * Constant-time check of the X-Telegram-Bot-Api-Secret-Token header.
   * `expected` is the per-org webhook secret; falls back to the env value.
   */
  verifyWebhookSecret(secret?: string, expected?: string | null): boolean {
    const reference = expected ?? process.env.TELEGRAM_WEBHOOK_SECRET;
    return SecretCipher.safeEqual(secret, reference ?? undefined);
  }

  async sendMessage(
    target: Record<string, unknown>,
    text: string,
    token?: string | null,
  ): Promise<ChannelSendResult> {
    const chatId = String(target['chat_id'] ?? '');
    if (!chatId) return { ok: false, error: 'Missing Telegram chat_id' };

    const botToken = token ?? this.envToken;
    if (!botToken) return { ok: true, skipped: true, externalMessageId: null };

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
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
