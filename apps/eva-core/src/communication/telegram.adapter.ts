import { Injectable } from '@nestjs/common';
import { SecretCipher } from '../common/secret-cipher';
import { ChannelSendResult, TelegramFileDownload } from './communication.types';

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
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      return { ok: false, error: await response.text() };
    }

    const body = (await response.json()) as { result?: { message_id?: number } };
    return { ok: true, externalMessageId: body.result?.message_id ? String(body.result.message_id) : null };
  }

  async sendPhoto(
    target: Record<string, unknown>,
    photoUrl: string,
    caption: string,
    token?: string | null,
  ): Promise<ChannelSendResult> {
    const chatId = String(target['chat_id'] ?? '');
    if (!chatId) return { ok: false, error: 'Missing Telegram chat_id' };

    const botToken = token ?? this.envToken;
    if (!botToken) return { ok: true, skipped: true, externalMessageId: null };

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: caption.slice(0, 1024),
      }),
    });

    if (!response.ok) {
      return { ok: false, error: await response.text() };
    }

    const body = (await response.json()) as { result?: { message_id?: number } };
    return { ok: true, externalMessageId: body.result?.message_id ? String(body.result.message_id) : null };
  }

  async downloadFile(fileId: string, token?: string | null): Promise<TelegramFileDownload> {
    const botToken = token ?? this.envToken;
    if (!botToken) return { ok: false, error: 'No Telegram bot token configured' };

    const metadataResponse = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!metadataResponse.ok) {
      return { ok: false, error: await metadataResponse.text() };
    }

    const metadata = (await metadataResponse.json()) as {
      ok?: boolean;
      description?: string;
      result?: { file_path?: string };
    };
    const filePath = metadata.result?.file_path;
    if (!metadata.ok || !filePath) {
      return { ok: false, error: metadata.description ?? 'Telegram did not return file_path' };
    }

    const fileResponse = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
    if (!fileResponse.ok) {
      return { ok: false, error: await fileResponse.text() };
    }

    return {
      ok: true,
      filePath,
      contentType: fileResponse.headers.get('content-type') ?? undefined,
      data: Buffer.from(await fileResponse.arrayBuffer()),
    };
  }
}
