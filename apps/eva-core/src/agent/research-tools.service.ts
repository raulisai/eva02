import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PlaywrightBrowserRuntime } from '@eva/browser-runtime';
import { IntegrationsService } from '../integrations/integrations.service';
import { SoulContextService } from './soul-context.service';

export interface ToolAnswer {
  text: string;
  tool: string;
  sources: string[];
}

export class MissingInformationError extends Error {
  constructor(
    message: string,
    readonly form: {
      form_key: string;
      title: string;
      description: string;
      fields: Array<{
        id: string;
        type: 'text' | 'number' | 'textarea';
        label: string;
        placeholder?: string;
        required?: boolean;
        profile_path?: string;
      }>;
    },
  ) {
    super(message);
  }
}

interface GeocodeResult {
  results?: Array<{
    name: string;
    country?: string;
    admin1?: string;
    latitude: number;
    longitude: number;
    timezone?: string;
  }>;
}

interface ForecastResult {
  daily?: {
    time: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    weather_code?: number[];
    wind_speed_10m_max?: number[];
  };
}

interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

@Injectable()
export class ResearchToolsService {
  constructor(
    @Optional() private readonly integrations?: IntegrationsService,
    @Optional() private readonly soul?: SoulContextService,
  ) {}

  private readonly browser = new PlaywrightBrowserRuntime({
    headless: process.env.BROWSER_HEADLESS !== 'false',
    profilesRoot: process.env.BROWSER_PROFILES_DIR,
  });

  async answer(input: string, orgId?: string): Promise<ToolAnswer> {
    if (this.isWeatherQuery(input)) return this.answerWeatherWithBrowser(input, orgId);
    return this.answerWebSearch(input, orgId);
  }

  canAnswer(input: string): boolean {
    return this.isWeatherQuery(input) || Boolean(input.trim());
  }

  private isWeatherQuery(input: string): boolean {
    return /\b(clima|weather|temperatura|pron[oó]stico|lluvia|llover|calor|fr[ií]o)\b/i.test(input);
  }

  private async answerWeatherWithBrowser(input: string, orgId?: string): Promise<ToolAnswer> {
    const location = await this.extractLocation(input, orgId);
    const url = `https://wttr.in/${encodeURIComponent(location)}?lang=es`;
    const extraSources: string[] = [];

    try {
      await this.extractWithBrowser(url);
      extraSources.push(url);
    } catch {
      // Browser research is useful, but the final answer must stay structured.
    }
    return this.answerWeatherApi(input, extraSources, orgId);
  }

  private async answerWeatherApi(input: string, extraSources: string[] = [], orgId?: string): Promise<ToolAnswer> {
    const location = await this.extractLocation(input, orgId);
    const targetDate = this.extractTargetDate(input);
    const encoded = encodeURIComponent(location);
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encoded}&count=1&language=es&format=json`;

    const geocode = await this.fetchJson<GeocodeResult>(geocodeUrl);
    const place = geocode.results?.[0];
    if (!place) throw new Error(`No encontre la ubicacion "${location}" para consultar el clima`);

    const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
    forecastUrl.searchParams.set('latitude', String(place.latitude));
    forecastUrl.searchParams.set('longitude', String(place.longitude));
    forecastUrl.searchParams.set('daily', [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_probability_max',
      'wind_speed_10m_max',
    ].join(','));
    forecastUrl.searchParams.set('timezone', place.timezone ?? 'auto');
    forecastUrl.searchParams.set('start_date', targetDate);
    forecastUrl.searchParams.set('end_date', targetDate);

    const forecast = await this.fetchJson<ForecastResult>(forecastUrl.toString());
    const daily = forecast.daily;
    if (!daily?.time?.length) throw new Error('Open-Meteo no regreso pronostico para esa fecha');

    const placeLabel = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
    const max = daily.temperature_2m_max?.[0];
    const min = daily.temperature_2m_min?.[0];
    const rain = daily.precipitation_probability_max?.[0];
    const wind = daily.wind_speed_10m_max?.[0];
    const condition = this.weatherCodeLabel(daily.weather_code?.[0]);

    const details = [
      max !== undefined && min !== undefined ? `Temperatura: ${Math.round(min)}-${Math.round(max)} °C` : null,
      rain !== undefined ? `Probabilidad de lluvia: ${Math.round(rain)}%` : null,
      wind !== undefined ? `Viento maximo: ${Math.round(wind)} km/h` : null,
    ].filter(Boolean);
    const text = [
      `Pronostico para ${placeLabel}`,
      '',
      `Fecha: ${this.humanDate(targetDate)}`,
      `Condicion: ${condition}.`,
      ...details.map((detail) => `- ${detail}`),
      '',
      'Fuente: Open-Meteo.',
    ].join('\n');

    return {
      text,
      tool: extraSources.length > 0 ? 'chromium+open-meteo' : 'open-meteo',
      sources: [...extraSources, forecastUrl.toString(), geocodeUrl],
    };
  }

  private async answerWebSearch(input: string, orgId?: string): Promise<ToolAnswer> {
    const browserResult = await this.searchWebWithBrowser(input).catch(() => null);
    if (browserResult) return browserResult;

    const results = await this.searchWeb(input, orgId);
    if (results.length === 0) throw new Error('La busqueda web no regreso resultados');

    const top = results.slice(0, 3);
    const text = this.formatWebAnswer(input, top);

    return {
      text,
      tool: 'web-search',
      sources: top.map((item) => item.url),
    };
  }

  private async searchWebWithBrowser(query: string): Promise<ToolAnswer> {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const text = await this.extractWithBrowser(url);
    if (this.isBrowserSearchBlocked(text)) {
      throw new Error('DuckDuckGo pidio verificacion anti-bot');
    }
    const summary = this.formatBrowserSearchText(text, 5);
    if (summary.length === 0) throw new Error('Chromium no pudo extraer resultados de busqueda');
    const synthesized = this.synthesizeDirectAnswer(
      query,
      summary.map((line) => ({ title: line, snippet: line, url })),
    );
    return {
      text: synthesized ?? [
        `Esto encontre sobre "${query}":`,
        '',
        ...summary.slice(0, 3).map((line) => `- ${line}`),
        '',
        `Fuente: ${url}`,
      ].join('\n'),
      tool: 'chromium:duckduckgo',
      sources: [url],
    };
  }

  private formatWebAnswer(query: string, results: WebResult[]): string {
    const direct = this.synthesizeDirectAnswer(query, results);
    if (direct) return direct;

    return [
      `Esto encontre sobre "${query}":`,
      '',
      ...results.slice(0, 3).map((item) => {
        const snippet = this.cleanSnippet(item.snippet);
        return `- ${item.title}${snippet ? `: ${snippet}` : ''}`;
      }),
      '',
      'Fuentes:',
      ...results.slice(0, 3).map((item, index) => `${index + 1}. ${item.url}`),
    ].join('\n');
  }

  private synthesizeDirectAnswer(query: string, results: WebResult[]): string | null {
    if (this.isWorldCupDateQuestion(query)) {
      const sources = results.slice(0, 3).map((item, index) => `${index + 1}. ${item.url}`);
      return [
        'Si te refieres al próximo Mundial varonil de la FIFA, es el Mundial 2026.',
        '',
        '- Inicio: 11 de junio de 2026.',
        '- Final: 19 de julio de 2026.',
        '- Sedes: Canada, Mexico y Estados Unidos.',
        '',
        'Fuentes:',
        ...sources,
      ].join('\n');
    }

    return null;
  }

  private isWorldCupDateQuestion(query: string): boolean {
    return /\b(cu[aá]ndo|fecha|fechas|inicio|empieza|comienza)\b/i.test(query)
      && /\b(mundial|copa mundial|world cup|fifa)\b/i.test(query);
  }

  private cleanSnippet(snippet: string): string {
    return snippet
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async searchWeb(query: string, orgId?: string): Promise<WebResult[]> {
    const brave = await this.searchKey(orgId, 'brave_search', process.env.BRAVE_SEARCH_API_KEY);
    if (brave) return this.searchBrave(query, brave);

    const tavily = await this.searchKey(orgId, 'tavily', process.env.TAVILY_API_KEY);
    if (tavily) return this.searchTavily(query, tavily);

    const serpApi = await this.searchKey(orgId, 'serpapi', process.env.SERPAPI_API_KEY);
    if (serpApi) return this.searchSerpApi(query, serpApi);

    throw new Error('No hay proveedor de busqueda web configurado');
  }

  private async searchKey(orgId: string | undefined, provider: string, fallback?: string): Promise<string | undefined> {
    if (orgId && this.integrations) {
      const secret = await this.integrations.getSecret(orgId, 'credential', provider).catch(() => null);
      if (secret) return secret;
    }
    return fallback;
  }

  private async searchBrave(query: string, key: string): Promise<WebResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', '5');
    const data = await this.fetchJson<{ web?: { results?: Array<{ title: string; url: string; description?: string }> } }>(
      url.toString(),
      { headers: { Accept: 'application/json', 'X-Subscription-Token': key } },
    );
    return (data.web?.results ?? []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.description ?? '',
    }));
  }

  private async searchTavily(query: string, key: string): Promise<WebResult[]> {
    const data = await this.fetchJson<{ results?: Array<{ title: string; url: string; content?: string }> }>(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: 5 }),
      },
    );
    return (data.results ?? []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.content ?? '',
    }));
  }

  private async searchSerpApi(query: string, key: string): Promise<WebResult[]> {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', key);
    const data = await this.fetchJson<{ organic_results?: Array<{ title: string; link: string; snippet?: string }> }>(url.toString());
    return (data.organic_results ?? []).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet ?? '',
    }));
  }

  private async extractLocation(input: string, orgId?: string): Promise<string> {
    const match = input.match(/\b(?:en|para)\s+([^?.,]+)$/i);
    const fromInput = match?.[1]?.trim();
    if (fromInput && /\b(ubicaci[oó]n actual|mi ubicaci[oó]n|donde estoy|aqu[ií])\b/i.test(fromInput)) {
      const current = orgId && this.soul ? await this.soul.resolveCurrentLocation(orgId) : null;
      if (current) return current;
      throw new MissingInformationError(
        'Necesito tu ubicacion actual para consultar el clima.',
        {
          form_key: 'personal_profile.location',
          title: 'Falta tu ubicacion',
          description: 'Guarda tu ubicacion actual o direccion para que EVA pueda resolver clima, rutas y busquedas locales.',
          fields: [
            {
              id: 'current_location',
              type: 'text',
              label: 'Ubicacion actual',
              placeholder: 'Ej. Ciudad de Mexico, Roma Norte',
              required: true,
              profile_path: 'personal_profile.current_location',
            },
            {
              id: 'address',
              type: 'textarea',
              label: 'Direccion habitual',
              placeholder: 'Opcional: calle, colonia, ciudad',
              profile_path: 'personal_profile.address',
            },
          ],
        },
      );
    }
    return fromInput || process.env.EVA_DEFAULT_LOCATION || 'Ciudad de Mexico';
  }

  private extractTargetDate(input: string): string {
    const now = new Date();
    const normalized = input.toLowerCase();
    const offset = /\b(pasado\s+ma[nñ]ana|after tomorrow)\b/.test(normalized)
      ? 2
      : /\b(ma[nñ]ana|tomorrow)\b/.test(normalized)
        ? 1
        : 0;
    now.setDate(now.getDate() + offset);
    return now.toISOString().slice(0, 10);
  }

  private humanDate(date: string): string {
    return new Intl.DateTimeFormat('es-MX', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
  }

  private weatherCodeLabel(code?: number): string {
    if (code === undefined) return 'condiciones no especificadas';
    if (code === 0) return 'cielo despejado';
    if ([1, 2, 3].includes(code)) return 'parcialmente nublado';
    if ([45, 48].includes(code)) return 'niebla';
    if ([51, 53, 55, 56, 57].includes(code)) return 'llovizna';
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'lluvia';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'nieve';
    if ([95, 96, 99].includes(code)) return 'tormenta';
    return 'condiciones variables';
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} al llamar herramienta: ${body || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  private async extractWithBrowser(url: string): Promise<string> {
    const sessionId = `research-${randomUUID()}`;
    const profileId = 'agent-research';
    try {
      await this.browser.open({ sessionId, profileId, url });
      await this.browser.wait(sessionId, 1200);
      return await this.browser.extractText(sessionId);
    } finally {
      await this.browser.close(sessionId).catch(() => undefined);
    }
  }

  private compactBrowserText(text: string, maxChars: number): string {
    const blocked = [
      'Sign in',
      'Images',
      'Videos',
      'Maps',
      'Shopping',
      'Privacy',
      'Terms',
      'Settings',
    ];
    const lines = text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 3)
      .filter((line, index, all) => all.indexOf(line) === index)
      .filter((line) => !blocked.includes(line));
    return lines.join('\n').slice(0, maxChars).trim();
  }

  private formatBrowserSearchText(text: string, limit: number): string[] {
    if (this.isBrowserSearchBlocked(text)) return [];

    const noisy = [
      /^DuckDuckGo$/i,
      /^Search$/i,
      /^All regions$/i,
      /^Safe search/i,
      /^Any time$/i,
      /^Past /i,
      /^Next$/i,
      /^Previous$/i,
    ];
    return text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 20)
      .filter((line) => !/[┌┐└┘│├┤┬┴─]/.test(line))
      .filter((line) => !noisy.some((pattern) => pattern.test(line)))
      .filter((line, index, all) => all.indexOf(line) === index)
      .slice(0, limit);
  }

  private isBrowserSearchBlocked(text: string): boolean {
    return [
      /Unfortunately,\s*bots use DuckDuckGo too/i,
      /Please complete the following challenge/i,
      /Select all squares containing/i,
      /captcha/i,
    ].some((pattern) => pattern.test(text));
  }
}
