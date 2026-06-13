import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { readFile, unlink, writeFile } from 'fs/promises';
import { SecretCipher } from '../common/secret-cipher';
import { ChannelSendResult, TelegramFileDownload } from './communication.types';

/** Límite conservador de la Bot API para envíos desde Buffer. */
const TELEGRAM_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

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

  async sendMessageWithInlineKeyboard(
    target: Record<string, unknown>,
    text: string,
    buttons: Array<{ text: string; callbackData: string }>,
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
        reply_markup: {
          inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))],
        },
      }),
    });

    if (!response.ok) {
      return { ok: false, error: await response.text() };
    }

    const body = (await response.json()) as { result?: { message_id?: number } };
    return { ok: true, externalMessageId: body.result?.message_id ? String(body.result.message_id) : null };
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, token?: string | null): Promise<void> {
    const botToken = token ?? this.envToken;
    if (!botToken) return;
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text ?? '', show_alert: false }),
    }).catch(() => undefined);
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

  /**
   * Envía un archivo (video, documento, audio) desde un Buffer a Telegram.
   *
   * - Archivos ≤50 MB: usa sendVideo (mp4/webm/mov) o sendDocument para el resto.
   * - Videos >50 MB: intenta comprimir con ffmpeg y enviar el resultado.
   * - Otros archivos >50 MB: devuelve error claro — el agente notifica al usuario.
   *
   * @param target   - debe tener `chat_id`
   * @param buffer   - contenido del archivo
   * @param filename - nombre con extensión (ej. "video.mp4")
   * @param caption  - texto opcional bajo el archivo
   * @param token    - bot token (si no se pasa, usa env)
   */
  async sendDocument(
    target: Record<string, unknown>,
    buffer: Buffer,
    filename: string,
    caption?: string,
    token?: string | null,
  ): Promise<ChannelSendResult & { oversized?: boolean }> {
    const chatId = String(target['chat_id'] ?? '');
    if (!chatId) return { ok: false, error: 'Missing Telegram chat_id' };

    const botToken = token ?? this.envToken;
    if (!botToken) return { ok: true, skipped: true, externalMessageId: null };

    // Elegir método: sendVideo para formatos nativos (mejor UX en Telegram), sendDocument para el resto.
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const isNativeVideo = ['mp4', 'webm', 'mov'].includes(ext);

    let uploadBuffer = buffer;
    let uploadFilename = filename;
    let uploadCaption = caption;

    if (buffer.length > TELEGRAM_MAX_BYTES && isNativeVideo) {
      const compressed = await this.compressVideoForTelegram(buffer, filename);
      if (compressed.ok && compressed.buffer.length <= TELEGRAM_MAX_BYTES) {
        uploadBuffer = compressed.buffer;
        uploadFilename = compressed.filename;
        const compressionNote = `Comprimido automáticamente de ${(buffer.length / 1024 / 1024).toFixed(1)} MB a ${(compressed.buffer.length / 1024 / 1024).toFixed(1)} MB.`;
        uploadCaption = caption ? `${caption}\n\n${compressionNote}` : compressionNote;
      } else {
        const reason = compressed.ok
          ? `ffmpeg generó ${(compressed.buffer.length / 1024 / 1024).toFixed(1)} MB`
          : compressed.error;
        return {
          ok: false,
          oversized: true,
          error: `El video pesa ${(buffer.length / 1024 / 1024).toFixed(1)} MB y no se pudo comprimir por debajo del límite de 50 MB de Telegram (${reason}).`,
        };
      }
    }

    if (uploadBuffer.length > TELEGRAM_MAX_BYTES) {
      return {
        ok: false,
        oversized: true,
        error: `El archivo pesa ${(uploadBuffer.length / 1024 / 1024).toFixed(1)} MB — supera el límite de 50 MB de la Bot API de Telegram. Considera comprimirlo o enviarlo como enlace.`,
      };
    }

    const uploadExt = uploadFilename.split('.').pop()?.toLowerCase() ?? ext;
    const method = isNativeVideo ? 'sendVideo' : 'sendDocument';
    const fieldName = isNativeVideo ? 'video' : 'document';

    const mimeMap: Record<string, string> = {
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
      mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4',
      pdf: 'application/pdf', zip: 'application/zip',
    };
    const mimeType = mimeMap[uploadExt] ?? 'application/octet-stream';

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append(fieldName, new Blob([new Uint8Array(uploadBuffer)], { type: mimeType }), uploadFilename);
    if (uploadCaption) form.append('caption', uploadCaption.slice(0, 1024));

    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      return { ok: false, error: await response.text() };
    }

    const body = (await response.json()) as { result?: { message_id?: number } };
    return { ok: true, externalMessageId: body.result?.message_id ? String(body.result.message_id) : null };
  }

  private async compressVideoForTelegram(
    buffer: Buffer,
    filename: string,
  ): Promise<{ ok: true; buffer: Buffer; filename: string } | { ok: false; error: string }> {
    const sourceExt = filename.split('.').pop()?.toLowerCase() ?? 'mp4';
    const stem = filename.replace(/\.[^.]+$/, '') || 'video';
    const jobId = randomUUID();
    const inputPath = join(tmpdir(), `eva-telegram-${jobId}.${sourceExt}`);
    const outputPath = join(tmpdir(), `eva-telegram-${jobId}-compressed.mp4`);

    try {
      await writeFile(inputPath, buffer);
      await this.runFfmpeg([
        '-y',
        '-i', inputPath,
        '-vf', 'scale=trunc(min(1280,iw)/2)*2:-2',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '30',
        '-maxrate', '1300k',
        '-bufsize', '2600k',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart',
        outputPath,
      ]);
      const compressed = await readFile(outputPath);
      if (compressed.length >= buffer.length) {
        return { ok: false, error: 'ffmpeg no redujo el tamaño del archivo' };
      }
      return { ok: true, buffer: compressed, filename: `${stem}.telegram.mp4` };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    } finally {
      await Promise.all([
        unlink(inputPath).catch(() => undefined),
        unlink(outputPath).catch(() => undefined),
      ]);
    }
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`ffmpeg exited ${code}${stderr ? `: ${stderr}` : ''}`));
      });
    });
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
