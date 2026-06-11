import { Test, TestingModule } from '@nestjs/testing';
import { ModelRouterService } from '../model-router.service';

global.fetch = jest.fn();

describe('ModelRouterService', () => {
  let service: ModelRouterService;

  function build() {
    return Test.createTestingModule({ providers: [ModelRouterService] })
      .compile()
      .then(m => m.get(ModelRouterService));
  }

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  // ── embed() ───────────────────────────────────────────────────────────────

  describe('embed()', () => {
    it('returns a 1536-dim normalised vector in dev mode', async () => {
      service = await build();
      const { embedding } = await service.embed('hello');
      expect(embedding).toHaveLength(1536);
      const mag = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
      expect(mag).toBeCloseTo(1, 5);
    });

    it('is deterministic', async () => {
      service = await build();
      const a = await service.embed('test');
      const b = await service.embed('test');
      expect(a.embedding).toEqual(b.embedding);
    });

    it('calls OpenAI when OPENAI_API_KEY is set', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      service = await build();
      const mockVec = new Array(1536).fill(0.1);
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok:   true,
        json: async () => ({ data: [{ embedding: mockVec }] }),
      });
      const result = await service.embed('openai embed');
      expect(fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result.embedding).toEqual(mockVec);
      expect(result.backend).toBe('openai');
    });
  });

  // ── generate() — stub mode ────────────────────────────────────────────────

  describe('generate() — no API key (stub)', () => {
    beforeEach(async () => { service = await build(); });

    it('returns a GenerateResult with text, model, backend, usage', async () => {
      const result = await service.generate('Hello world');
      expect(result.text).toBeTruthy();
      expect(result.model).toBeTruthy();
      expect(result.backend).toBe('openai');
      expect(result.usage).toMatchObject({
        promptTokens:     expect.any(Number),
        completionTokens: expect.any(Number),
        totalTokens:      expect.any(Number),
      });
    });

    it('stub returns JSON string when responseFormat is json', async () => {
      const result = await service.generate('anything', { responseFormat: 'json' });
      expect(() => JSON.parse(result.text)).not.toThrow();
    });

    it('does not call fetch in stub mode', async () => {
      await service.generate('test');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // ── generate() — OpenAI backend ───────────────────────────────────────────

  describe('generate() — OpenAI backend', () => {
    beforeEach(async () => {
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      service = await build();
    });

    it('calls OpenAI chat completions endpoint', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok:   true,
        json: async () => ({
          choices: [{ message: { content: 'OpenAI response' } }],
          model:   'gpt-4o-mini',
          usage:   { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      });

      const result = await service.generate('Hello', { backend: 'openai', budget: 'cheap' });
      expect(fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method:  'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer sk-openai-test' }),
        }),
      );
      expect(result.text).toBe('OpenAI response');
      expect(result.backend).toBe('openai');
      expect(result.usage.totalTokens).toBe(30);
    });

    it('adds response_format when responseFormat is json', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok:   true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
          model:   'gpt-4o-mini',
          usage:   { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
      });

      await service.generate('prompt', { responseFormat: 'json' });
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.model).toBe('gpt-4.1-nano');
    });

    it('throws on non-ok response', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false, status: 429, text: async () => 'rate limit',
      });
      await expect(service.generate('hi')).rejects.toThrow(/429/);
    });
  });

  // ── generate() — Google backend ───────────────────────────────────────────

  describe('generate() — Google backend', () => {
    beforeEach(async () => {
      process.env.GOOGLE_API_KEY = 'google-test';
      service = await build();
    });

    it('uses Gemini Flash-Lite as the cheapest useful default', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Gemini response' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
          modelVersion: 'gemini-2.5-flash-lite',
        }),
      });

      const result = await service.generate('clasifica esto', { responseFormat: 'json' });

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/models/gemini-2.5-flash-lite:generateContent?key=google-test'),
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(result.backend).toBe('google');
      expect(result.model).toBe('gemini-2.5-flash-lite');
    });
  });

  // ── generate() — Claude backend ───────────────────────────────────────────

  describe('generate() — Claude backend', () => {
    beforeEach(async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      service = await build();
    });

    it('calls Anthropic messages endpoint', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok:   true,
        json: async () => ({
          content: [{ type: 'text', text: 'Claude response' }],
          model:   'claude-haiku-4-5-20251001',
          usage:   { input_tokens: 8, output_tokens: 12 },
        }),
      });

      const result = await service.generate('Hello', { backend: 'claude' });
      expect(fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method:  'POST',
          headers: expect.objectContaining({ 'x-api-key': 'sk-ant-test' }),
        }),
      );
      expect(result.text).toBe('Claude response');
      expect(result.backend).toBe('claude');
      expect(result.usage.promptTokens).toBe(8);
      expect(result.usage.completionTokens).toBe(12);
      expect(result.usage.totalTokens).toBe(20);
    });

    it('sends system prompt in top-level "system" field', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok:   true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          model:   'claude-haiku-4-5-20251001',
          usage:   { input_tokens: 5, output_tokens: 3 },
        }),
      });

      await service.generate('prompt', { backend: 'claude', systemPrompt: 'Be brief.' });
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.system).toBe('Be brief.');
    });

    it('enforces JSON-only output via system prompt when responseFormat is json', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok:   true,
        json: async () => ({
          content: [{ type: 'text', text: '{"a":1}' }],
          model:   'claude-haiku-4-5-20251001',
          usage:   { input_tokens: 5, output_tokens: 3 },
        }),
      });

      await service.generate('prompt', { backend: 'claude', systemPrompt: 'Plan.', responseFormat: 'json' });
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.system).toContain('Plan.');
      expect(body.system).toContain('JSON');
    });

    it('strips code fences from JSON responses', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok:   true,
        json: async () => ({
          content: [{ type: 'text', text: '```json\n{"a":1}\n```' }],
          model:   'claude-haiku-4-5-20251001',
          usage:   { input_tokens: 5, output_tokens: 3 },
        }),
      });

      const result = await service.generate('prompt', { backend: 'claude', responseFormat: 'json' });
      expect(result.text).toBe('{"a":1}');
      expect(() => JSON.parse(result.text)).not.toThrow();
    });
  });

  // ── budget → model selection ──────────────────────────────────────────────

  describe('budget mapping', () => {
    beforeEach(async () => {
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      service = await build();
    });

    const cases: Array<['cheap' | 'balanced' | 'powerful', string]> = [
      ['cheap',    'gpt-4.1-nano'],
      ['balanced', 'gpt-4.1-mini'],
      ['powerful', 'gpt-4.1'],
    ];

    test.each(cases)('budget=%s → model contains "%s"', async (budget, expectedModel) => {
      (fetch as jest.Mock).mockResolvedValue({
        ok:   true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          model:   expectedModel,
          usage:   { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

      await service.generate('test', { budget });
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.model).toBe(expectedModel);
    });
  });

  describe('cost-first provider selection', () => {
    it('prefers Google over OpenAI for cheap/balanced when both are configured', async () => {
      process.env.GOOGLE_API_KEY = 'google-test';
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      service = await build();
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { totalTokenCount: 1 },
        }),
      });

      await service.generate('short task', { budget: 'cheap' });

      expect((fetch as jest.Mock).mock.calls[0][0]).toContain('gemini-2.5-flash-lite');
    });

    it('uses Claude first only for powerful budget when configured', async () => {
      process.env.GOOGLE_API_KEY = 'google-test';
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      service = await build();
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-opus-4-8',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });

      await service.generate('hard task', { budget: 'powerful' });

      expect((fetch as jest.Mock).mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
      const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.model).toBe('claude-opus-4-8');
    });
  });

  // ── realtimeToken() ───────────────────────────────────────────────────────

  describe('realtimeToken()', () => {
    it('throws when OPENAI_API_KEY is not set', async () => {
      service = await build();
      await expect(service.realtimeToken('org-1')).rejects.toThrow(/OPENAI_API_KEY/);
    });

    it('calls OpenAI realtime sessions endpoint and returns token', async () => {
      process.env.OPENAI_API_KEY = 'sk-rt-test';
      service = await build();

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok:   true,
        json: async () => ({
          client_secret: { value: 'eph-token-123', expires_at: 9999999999 },
          id:            'session-abc',
        }),
      });

      const token = await service.realtimeToken('org-1');
      expect(fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/realtime/sessions',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(token.clientSecret).toBe('eph-token-123');
      expect(token.sessionId).toBe('session-abc');
      expect(token.expiresAt).toBe(9999999999);
    });

    it('throws on non-ok realtime response', async () => {
      process.env.OPENAI_API_KEY = 'sk-rt-test';
      service = await build();
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false, status: 403, text: async () => 'forbidden',
      });
      await expect(service.realtimeToken('org-1')).rejects.toThrow(/403/);
    });
  });
});
