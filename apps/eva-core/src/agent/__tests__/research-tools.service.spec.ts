import { ResearchToolsService } from '../research-tools.service';

describe('ResearchToolsService', () => {
  let service: ResearchToolsService;

  beforeEach(() => {
    service = new ResearchToolsService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes weather queries straight to Open-Meteo without browser extraction', async () => {
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
            weather_code: [0],
            temperature_2m_min: [17],
            temperature_2m_max: [26],
            precipitation_probability_max: [10],
            wind_speed_10m_max: [12],
          },
        }),
      } as never);
    const browserSpy = jest.spyOn(service as unknown as {
      extractWithBrowser(url: string): Promise<string>;
    }, 'extractWithBrowser');

    const result = await service.answer('clima manana en Ciudad de Mexico');

    expect(result.tool).toBe('open-meteo');
    expect(result.text).toContain('Pronostico para Ciudad de Mexico');
    expect(browserSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it('formats multi-day weather range API data correctly', async () => {
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
            time: ['2026-06-12', '2026-06-13', '2026-06-14'],
            weather_code: [61, 0, 3],
            temperature_2m_min: [15, 16, 17],
            temperature_2m_max: [24, 25, 26],
            precipitation_probability_max: [91, 10, 20],
            wind_speed_10m_max: [12, 11, 10],
          },
        }),
      } as never);

    const result = await (service as unknown as {
      answerWeatherApi(input: string, extraSources?: string[]): Promise<{ text: string; tool: string }>;
    }).answerWeatherApi('clima de los siguientes 3 dias en Ciudad de Mexico', []);

    expect(result.tool).toBe('open-meteo');
    expect(result.text).toContain('Pronostico para Ciudad de Mexico');
    expect(result.text).toContain('Fecha: viernes, 12 de junio de 2026');
    expect(result.text).toContain('Fecha: sábado, 13 de junio de 2026');
    expect(result.text).toContain('Fecha: domingo, 14 de junio de 2026');
    expect(result.text).toContain('- Temperatura: 15-24 °C');
    expect(result.text).toContain('- Temperatura: 16-25 °C');
    expect(result.text).toContain('- Temperatura: 17-26 °C');

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

  it('filters DuckDuckGo anti-bot challenges out of browser search results', () => {
    const raw = [
      'DuckDuckGo',
      'Unfortunately, bots use DuckDuckGo too.',
      'Please complete the following challenge to confirm this search was made by a human.',
      'Select all squares containing a duck:',
    ].join('\n');

    const lines = (service as unknown as {
      formatBrowserSearchText(text: string, limit: number): string[];
    }).formatBrowserSearchText(raw, 5);

    expect(lines).toEqual([]);
  });

  it('falls back to a configured search API when DuckDuckGo blocks Chromium', async () => {
    jest.spyOn(service as unknown as { extractWithBrowser(url: string): Promise<string> }, 'extractWithBrowser')
      .mockResolvedValue([
        'Unfortunately, bots use DuckDuckGo too.',
        'Please complete the following challenge to confirm this search was made by a human.',
        'Select all squares containing a duck:',
      ].join('\n'));
    jest.spyOn(service as unknown as { searchKey(orgId: string | undefined, provider: string, fallback?: string): Promise<string | undefined> }, 'searchKey')
      .mockImplementation(async (_orgId, provider) => provider === 'brave_search' ? 'brave-key' : undefined);
    jest.spyOn(service as unknown as { searchBrave(query: string, key: string): Promise<Array<{ title: string; url: string; snippet: string }>> }, 'searchBrave')
      .mockResolvedValue([
        {
          title: 'Calendario oficial FIFA',
          url: 'https://www.fifa.com/',
          snippet: 'Mexico juega en el partido inaugural del Mundial 2026.',
        },
      ]);

    const result = await (service as unknown as {
      answerWebSearch(input: string, orgId?: string): Promise<{ text: string; tool: string; sources: string[] }>;
    }).answerWebSearch('cuando juega mexico en el mundial', 'org-1');

    expect(result.tool).toBe('web-search');
    expect(result.text).toContain('Mundial 2026');
    expect(result.text).toContain('Fuentes:');
    expect(result.text).not.toContain('Select all squares');
    expect(result.sources).toEqual(['https://www.fifa.com/']);
  });

  it('answers World Cup date questions directly instead of returning raw search snippets', async () => {
    jest.spyOn(service as unknown as { extractWithBrowser(url: string): Promise<string> }, 'extractWithBrowser')
      .mockRejectedValue(new Error('browser unavailable'));
    jest.spyOn(service as unknown as { searchKey(orgId: string | undefined, provider: string, fallback?: string): Promise<string | undefined> }, 'searchKey')
      .mockImplementation(async (_orgId, provider) => provider === 'brave_search' ? 'brave-key' : undefined);
    jest.spyOn(service as unknown as { searchBrave(query: string, key: string): Promise<Array<{ title: string; url: string; snippet: string }>> }, 'searchBrave')
      .mockResolvedValue([
        {
          title: 'Copa Mundial de la FIFA 2026',
          url: 'https://www.fifa.com/es/tournaments/mens/worldcup/canadamexicousa2026/',
          snippet: 'Pagina oficial del Mundial 2026.',
        },
        {
          title: 'Calendario del Mundial 2026',
          url: 'https://example.com/calendario',
          snippet: '<strong>El domingo 19 de julio</strong> se disputara la Gran Final.',
        },
      ]);

    const result = await (service as unknown as {
      answerWebSearch(input: string, orgId?: string): Promise<{ text: string; tool: string; sources: string[] }>;
    }).answerWebSearch('cuando es el mundial?', 'org-1');

    expect(result.text).toContain('Inicio: 11 de junio de 2026');
    expect(result.text).toContain('Final: 19 de julio de 2026');
    expect(result.text).toContain('Canada, Mexico y Estados Unidos');
    expect(result.text).toContain('Fuentes:');
    expect(result.text).not.toContain('Encontre estos resultados actuales');
    expect(result.text).not.toContain('<strong>');
  });

  it('answers recipe requests with TheMealDB and a compact reusable format', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          meals: [{ idMeal: '52795', strMeal: 'Chicken Handi' }],
        }),
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          meals: [{
            idMeal: '52795',
            strMeal: 'Chicken Handi',
            strCategory: 'Chicken',
            strArea: 'Indian',
            strIngredient1: 'Chicken',
            strMeasure1: '1.2 kg',
            strIngredient2: 'Onion',
            strMeasure2: '5 thinly sliced',
            strInstructions: 'Heat oil in a large pan. Cook onions until golden. Add chicken and spices. Simmer until cooked.',
            strSource: 'https://www.themealdb.com/meal/52795',
          }],
        }),
      } as never);

    const result = await service.answer('dame una receta con pollo');

    expect(result.tool).toBe('themealdb');
    expect(result.text).toContain('Receta: Chicken Handi');
    expect(result.text).toContain('Ingredientes: 1.2 kg Chicken, 5 thinly sliced Onion.');
    expect(result.text).toContain('Pasos:');
    expect(result.sources[0]).toContain('filter.php?i=chicken_breast');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
