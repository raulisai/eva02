import { ResearchToolsService } from '../research-tools.service';

describe('ResearchToolsService', () => {
  let service: ResearchToolsService;

  beforeEach(() => {
    service = new ResearchToolsService();
  });

  it('formats weather API data as a human-readable answer', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{
            name: 'Ciudad de Mexico',
            admin1: 'Ciudad de Mexico',
            country: 'Mexico',
            latitude: 19.43,
            longitude: -99.13,
            timezone: 'America/Mexico_City',
          }],
        }),
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          daily: {
            time: ['2026-06-11'],
            weather_code: [61],
            temperature_2m_min: [18],
            temperature_2m_max: [24],
            precipitation_probability_max: [47],
            wind_speed_10m_max: [16],
          },
        }),
      } as never);

    const result = await (service as unknown as {
      answerWeatherApi(input: string, extraSources?: string[]): Promise<{ text: string; tool: string }>;
    }).answerWeatherApi('cual es el clima de manana en Ciudad de Mexico', ['https://wttr.in/Ciudad%20de%20Mexico?lang=es']);

    expect(result.tool).toBe('chromium+open-meteo');
    expect(result.text).toContain('Pronostico para Ciudad de Mexico');
    expect(result.text).toContain('Fecha:');
    expect(result.text).toContain('- Temperatura: 18-24 °C');
    expect(result.text).toContain('- Probabilidad de lluvia: 47%');
    expect(result.text).not.toMatch(/[┌┐└┘│├┤┬┴─]/);
    expect(result.text).not.toContain('_ /"".-.');

    fetchMock.mockRestore();
  });

  it('filters browser search text into readable bullets', () => {
    const raw = [
      'DuckDuckGo',
      'Search',
      '┌─────────────┐',
      'OpenAI launches new product with details from a current source',
      'OpenAI launches new product with details from a current source',
      'Another useful result with enough context for a human',
    ].join('\n');

    const lines = (service as unknown as {
      formatBrowserSearchText(text: string, limit: number): string[];
    }).formatBrowserSearchText(raw, 5);

    expect(lines).toEqual([
      'OpenAI launches new product with details from a current source',
      'Another useful result with enough context for a human',
    ]);
  });
});
