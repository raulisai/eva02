import { DatabaseService } from '../../database/database.service';
import { EventBusService } from '../../events/event-bus.service';
import { IntegrationsService } from '../../integrations/integrations.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { MediaService } from '../media.service';

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TASK = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('MediaService', () => {
  let service: MediaService;
  let db: jest.Mocked<DatabaseService>;
  let events: jest.Mocked<EventBusService>;
  let integrations: jest.Mocked<IntegrationsService>;
  let modelRouter: jest.Mocked<ModelRouterService>;

  beforeEach(() => {
    const bucket = {
      upload: jest.fn().mockResolvedValue({ error: null }),
      getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://bucket/eva-media/image.png' } }),
    };
    db = {
      admin: {
        storage: {
          getBucket: jest.fn().mockResolvedValue({ data: { id: 'eva-media' } }),
          createBucket: jest.fn().mockResolvedValue({ data: null, error: null }),
          from: jest.fn().mockReturnValue(bucket),
        },
      },
    } as unknown as jest.Mocked<DatabaseService>;
    events = { publish: jest.fn().mockResolvedValue('0-1') } as unknown as jest.Mocked<EventBusService>;
    integrations = {
      getSecret: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<IntegrationsService>;
    modelRouter = {
      generate: jest.fn(),
    } as unknown as jest.Mocked<ModelRouterService>;
    service = new MediaService(db, events, modelRouter, integrations);
    jest.spyOn(global, 'fetch' as never).mockReset();
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates image bytes with OpenAI Images when an OpenAI key is configured', async () => {
    integrations.getSecret.mockImplementation(async (_orgId, _kind, provider) => provider === 'openai' ? 'openai-key' : null);
    const imageBytes = Buffer.from('png-image');
    jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: imageBytes.toString('base64') }] }),
    } as never);

    const url = await service.sendImage(ORG, TASK, 'dame una imagen de un perro conduciendo');

    expect(url).toBe('https://bucket/eva-media/image.png');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer openai-key' }),
      }),
    );
    const storage = db.admin.storage.from('eva-media');
    expect(storage.upload).toHaveBeenCalledWith(
      expect.stringContaining(`${ORG}/${TASK}/`),
      imageBytes,
      expect.objectContaining({ contentType: 'image/png', upsert: true }),
    );
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task.media',
      payload: expect.objectContaining({ kind: 'image', content_type: 'image/png' }),
    }));
    expect(modelRouter.generate).not.toHaveBeenCalled();
  });

  it('falls back to Gemini image generation when OpenAI is not configured', async () => {
    integrations.getSecret.mockImplementation(async (_orgId, _kind, provider) => provider === 'google' ? 'google-key' : null);
    const imageBytes = Buffer.from('gemini-png');
    jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: 'image/png', data: imageBytes.toString('base64') } }],
          },
        }],
      }),
    } as never);

    const url = await service.sendImage(ORG, TASK, 'dibuja un perro conduciendo');

    expect(url).toBe('https://bucket/eva-media/image.png');
    expect(fetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-goog-api-key': 'google-key' }),
      }),
    );
    const storage = db.admin.storage.from('eva-media');
    expect(storage.upload).toHaveBeenCalledWith(
      expect.stringContaining(`${ORG}/${TASK}/`),
      imageBytes,
      expect.objectContaining({ contentType: 'image/png', upsert: true }),
    );
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task.media',
      payload: expect.objectContaining({ kind: 'image', content_type: 'image/png' }),
    }));
  });
});
