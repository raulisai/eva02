import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EventBusService } from '../events/event-bus.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { ModelRouterService } from '../model-router/model-router.service';

const BUCKET = 'eva-media';

/**
 * Generates and ships media replies (images as SVG, audio via TTS) to a
 * public Supabase Storage bucket, then announces them with task.media events
 * so the playground/watch can render them inline.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private bucketReady = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly modelRouter: ModelRouterService,
    private readonly integrations: IntegrationsService,
  ) {}

  wantsImage(text: string): boolean {
    return /\b(imagen|imágenes|foto|dibuja|dibujo|gráfic[oa]|diagrama|muéstrame|logo|ilustra)\b/i.test(text);
  }

  wantsAudio(text: string): boolean {
    return /\b(audio|voz|sonido|dímelo en voz|léeme|nota de voz)\b/i.test(text);
  }

  /** Model draws an SVG → uploaded to the bucket → task.media event. */
  async sendImage(orgId: string, taskId: string, subject: string): Promise<string | null> {
    try {
      const generated = await this.modelRouter.generate(
        `Dibuja un SVG sobre: ${subject}`,
        {
          orgId,
          budget: 'balanced',
          maxTokens: 1800,
          systemPrompt:
            'Responde ÚNICAMENTE con un SVG válido y autocontenido (sin markdown, sin explicación). '
            + 'Empieza con <svg y termina con </svg>. viewBox="0 0 400 300", fondo oscuro, estilo limpio.',
        },
      );
      const match = generated.text.match(/<svg[\s\S]*<\/svg>/i);
      if (!match) {
        this.logger.warn('Model did not return a usable SVG');
        return null;
      }
      const url = await this.upload(orgId, taskId, 'image.svg', Buffer.from(match[0], 'utf8'), 'image/svg+xml');
      if (url) await this.announce(orgId, taskId, 'image', url, 'image/svg+xml');
      return url;
    } catch (error) {
      this.logger.warn(`sendImage failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** OpenAI TTS (org key first) → mp3 in the bucket → task.media event. */
  async sendAudio(orgId: string, taskId: string, text: string): Promise<string | null> {
    const key = (await this.integrations.getSecret(orgId, 'model', 'openai').catch(() => null))
      ?? process.env.OPENAI_API_KEY;
    if (!key) {
      this.logger.warn('No OpenAI key for TTS — skipping audio');
      return null;
    }
    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'tts-1', voice: 'nova', input: text.slice(0, 1000), response_format: 'mp3' }),
      });
      if (!res.ok) {
        this.logger.warn(`TTS failed: HTTP ${res.status}`);
        return null;
      }
      const audio = Buffer.from(await res.arrayBuffer());
      const url = await this.upload(orgId, taskId, 'speech.mp3', audio, 'audio/mpeg');
      if (url) await this.announce(orgId, taskId, 'audio', url, 'audio/mpeg');
      return url;
    } catch (error) {
      this.logger.warn(`sendAudio failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** Uploads any buffer org-scoped and returns its public URL. */
  async upload(orgId: string, taskId: string, filename: string, data: Buffer, contentType: string): Promise<string | null> {
    await this.ensureBucket();
    const path = `${orgId}/${taskId}/${Date.now()}-${filename}`;
    const { error } = await this.db.admin.storage.from(BUCKET).upload(path, data, { contentType, upsert: true });
    if (error) {
      this.logger.warn(`storage upload failed: ${error.message}`);
      return null;
    }
    const { data: pub } = this.db.admin.storage.from(BUCKET).getPublicUrl(path);
    return pub.publicUrl;
  }

  private announce(orgId: string, taskId: string, kind: 'image' | 'audio', url: string, contentType: string) {
    return this.events.publish({ type: 'task.media', orgId, taskId, payload: { kind, url, content_type: contentType } });
  }

  private async ensureBucket() {
    if (this.bucketReady) return;
    try {
      const { data } = await this.db.admin.storage.getBucket(BUCKET);
      if (!data) {
        await this.db.admin.storage.createBucket(BUCKET, { public: true });
        this.logger.log(`Created public storage bucket "${BUCKET}"`);
      }
    } catch {
      // getBucket throws on missing in some client versions — try create anyway
      await this.db.admin.storage.createBucket(BUCKET, { public: true }).catch(() => undefined);
    }
    this.bucketReady = true;
  }
}
