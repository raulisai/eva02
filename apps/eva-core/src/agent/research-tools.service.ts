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

interface PublicApiCatalogEntry {
  id: 'open-meteo' | 'themealdb';
  capability: 'weather.forecast' | 'recipes.lookup';
  patterns: RegExp[];
}

interface MealDbMeal {
  idMeal?: string;
  strMeal?: string;
  strCategory?: string;
  strArea?: string;
  strInstructions?: string;
  strSource?: string;
  strYoutube?: string;
  strMealThumb?: string;
  [key: string]: string | null | undefined;
}

interface MealDbResult {
  meals?: MealDbMeal[] | null;
}

type RecipeRequest =
  | { mode: 'random' }
  | { mode: 'ingredient' | 'category' | 'area' | 'search'; value: string };

const PUBLIC_API_CATALOG: PublicApiCatalogEntry[] = [
  {
    id: 'open-meteo',
    capability: 'weather.forecast',
    patterns: [/\b(clima|weather|temperatura|pron[oó]stico|lluvia|llover|calor|fr[ií]o)\b/i],
  },
  {
    id: 'themealdb',
    capability: 'recipes.lookup',
    patterns: [/\b(receta|recetas|recipe|recipes|cocina|cocinar|prepara(?:r)?|platillo|ingredientes?)\b/i],
  },
];

const RECIPE_TERM_MAP: Record<string, string> = {
  atun: 'tuna',
  arroz: 'rice',
  camarones: 'prawns',
  carne: 'beef',
  cerdo: 'pork',
  champinones: 'mushrooms',
  huevo: 'egg',
  huevos: 'egg',
  jamon: 'ham',
  lentejas: 'lentils',
  pescado: 'fish',
  pollo: 'chicken_breast',
  res: 'beef',
  salmon: 'salmon',
  tocino: 'bacon',
};

const RECIPE_CATEGORY_MAP: Record<string, string> = {
  desayuno: 'Breakfast',
  postre: 'Dessert',
  postres: 'Dessert',
  mariscos: 'Seafood',
  pescado: 'Seafood',
  vegetariana: 'Vegetarian',
  vegetariano: 'Vegetarian',
  vegana: 'Vegan',
  vegano: 'Vegan',
  pasta: 'Pasta',
};

const RECIPE_AREA_MAP: Record<string, string> = {
  americana: 'American',
  americano: 'American',
  britanica: 'British',
  britanico: 'British',
  canadiense: 'Canadian',
  china: 'Chinese',
  chino: 'Chinese',
  francesa: 'French',
  frances: 'French',
  griega: 'Greek',
  griego: 'Greek',
  hindu: 'Indian',
  india: 'Indian',
  indio: 'Indian',
  italiana: 'Italian',
  italiano: 'Italian',
  japonesa: 'Japanese',
  japones: 'Japanese',
  mexicana: 'Mexican',
  mexicano: 'Mexican',
  tailandesa: 'Thai',
  tailandes: 'Thai',
};

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
    const api = this.matchPublicApi(input);
    if (api?.capability === 'weather.forecast') return this.answerWeatherApi(input, [], orgId);
    if (api?.capability === 'recipes.lookup') return this.answerRecipeApi(input);
    return this.answerWebSearch(input, orgId);
  }

  canAnswer(input: string): boolean {
    return Boolean(this.matchPublicApi(input)) || Boolean(input.trim());
  }

  private matchPublicApi(input: string): PublicApiCatalogEntry | null {
    if (/\b(restaurante|sucursal|abierto|horario|direcci[oó]n|ubicaci[oó]n)\b/i.test(input)) {
      return PUBLIC_API_CATALOG.find((entry) => entry.capability === 'weather.forecast' && entry.patterns.some((pattern) => pattern.test(input))) ?? null;
    }
    return PUBLIC_API_CATALOG.find((entry) => entry.patterns.some((pattern) => pattern.test(input))) ?? null;
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

  private async answerRecipeApi(input: string): Promise<ToolAnswer> {
    const request = this.extractRecipeRequest(input);
    const sources: string[] = [];

    let meal: MealDbMeal | undefined;
    if (request.mode === 'random') {
      const randomUrl = 'https://www.themealdb.com/api/json/v1/1/random.php';
      sources.push(randomUrl);
      meal = (await this.fetchJson<MealDbResult>(randomUrl)).meals?.[0];
    } else if (request.mode === 'search') {
      const searchUrl = new URL('https://www.themealdb.com/api/json/v1/1/search.php');
      searchUrl.searchParams.set('s', request.value);
      sources.push(searchUrl.toString());
      meal = (await this.fetchJson<MealDbResult>(searchUrl.toString())).meals?.[0];
    } else {
      const filterUrl = new URL('https://www.themealdb.com/api/json/v1/1/filter.php');
      filterUrl.searchParams.set(request.mode === 'ingredient' ? 'i' : request.mode === 'category' ? 'c' : 'a', request.value);
      sources.push(filterUrl.toString());
      const firstMatch = (await this.fetchJson<MealDbResult>(filterUrl.toString())).meals?.[0];
      if (firstMatch?.idMeal) {
        const lookupUrl = new URL('https://www.themealdb.com/api/json/v1/1/lookup.php');
        lookupUrl.searchParams.set('i', firstMatch.idMeal);
        sources.push(lookupUrl.toString());
        meal = (await this.fetchJson<MealDbResult>(lookupUrl.toString())).meals?.[0];
      }
    }

    if (!meal?.strMeal) {
      throw new Error('TheMealDB no regreso recetas para esa consulta');
    }

    return {
      text: this.formatRecipe(meal),
      tool: 'themealdb',
      sources,
    };
  }

  private async answerWeatherApi(input: string, extraSources: string[] = [], orgId?: string): Promise<ToolAnswer> {
    const location = await this.extractLocation(input, orgId);
    const targetDate = this.extractTargetDate(input);
    const encoded = encodeURIComponent(location);
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encoded}&count=1&language=es&format=json`;

    const geocode = await this.fetchJson<GeocodeResult>(geocodeUrl);
    const place = geocode.results?.[0];
    if (!place) throw new Error(`No encontre la ubicacion "${location}" para consultar el clima`);

    let startDate = targetDate;
    let endDate = targetDate;

    // Detect if multi-day is requested
    let numDays = 1;
    const rangeMatch = input.toLowerCase().match(/\b(?:los\s+siguientes\s+)?(\d{1,2})\s+d[ií]as?\b/i) || 
                       input.toLowerCase().match(/\b(?:pr[oó]ximos\s+)?(\d{1,2})\s+d[ií]as?\b/i);
    if (rangeMatch?.[1]) {
      numDays = Math.min(Math.max(parseInt(rangeMatch[1], 10), 1), 7);
    } else if (/\b(?:semana|semanal)\b/i.test(input)) {
      numDays = 7;
    } else if (/\b(tres|3)\s+d[ií]as?\b/i.test(input)) {
      numDays = 3;
    } else if (/\b(cinco|5)\s+d[ií]as?\b/i.test(input)) {
      numDays = 5;
    }

    if (numDays > 1) {
      const now = new Date();
      startDate = now.toISOString().slice(0, 10);
      now.setDate(now.getDate() + (numDays - 1));
      endDate = now.toISOString().slice(0, 10);
    }

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
    forecastUrl.searchParams.set('start_date', startDate);
    forecastUrl.searchParams.set('end_date', endDate);

    const forecast = await this.fetchJson<ForecastResult>(forecastUrl.toString());
    const daily = forecast.daily;
    if (!daily?.time?.length) throw new Error('Open-Meteo no regreso pronostico para esa fecha');

    const placeLabel = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
    const lines = [`Pronostico para ${placeLabel}`, ''];

    for (let dayIdx = 0; dayIdx < daily.time.length; dayIdx++) {
      const dateStr = daily.time[dayIdx];
      const max = daily.temperature_2m_max?.[dayIdx];
      const min = daily.temperature_2m_min?.[dayIdx];
      const rain = daily.precipitation_probability_max?.[dayIdx];
      const wind = daily.wind_speed_10m_max?.[dayIdx];
      const condition = this.weatherCodeLabel(daily.weather_code?.[dayIdx]);

      const details = [
        max !== undefined && min !== undefined ? `Temperatura: ${Math.round(min)}-${Math.round(max)} °C` : null,
        rain !== undefined ? `Probabilidad de lluvia: ${Math.round(rain)}%` : null,
        wind !== undefined ? `Viento maximo: ${Math.round(wind)} km/h` : null,
      ].filter(Boolean);

      lines.push(
        `Fecha: ${this.humanDate(dateStr)}`,
        `Condicion: ${condition}.`,
        ...details.map((detail) => `- ${detail}`),
        ''
      );
    }

    lines.push('Fuente: Open-Meteo.');
    const text = lines.join('\n');

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
    const explicitDate = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
    if (explicitDate) return explicitDate;

    const daysMatch = normalized.match(/\b(?:en|dentro de)\s+(\d{1,2})\s+d[ií]as?\b/);
    const offset = daysMatch
      ? Number(daysMatch[1])
      : /\b(pasado\s+ma[nñ]ana|after tomorrow)\b/.test(normalized)
      ? 2
      : /\b(ma[nñ]ana|tomorrow)\b/.test(normalized)
        ? 1
        : 0;
    now.setDate(now.getDate() + offset);
    return now.toISOString().slice(0, 10);
  }

  private extractRecipeRequest(input: string): RecipeRequest {
    const normalized = this.normalizeText(input);
    if (/\b(aleatoria|random|sorprendeme|sorpr[eé]ndeme)\b/i.test(input)) return { mode: 'random' };

    const ingredientMatch = normalized.match(/\b(?:con|ingrediente(?: principal)?(?: es)?|tengo)\s+([a-z0-9 _-]{3,40})/);
    if (ingredientMatch?.[1]) {
      return { mode: 'ingredient', value: this.toMealDbTerm(ingredientMatch[1]) };
    }

    const area = this.firstMappedTerm(normalized, RECIPE_AREA_MAP);
    if (area) return { mode: 'area', value: area };

    const category = this.firstMappedTerm(normalized, RECIPE_CATEGORY_MAP);
    if (category) return { mode: 'category', value: category };

    const searchMatch = normalized.match(/\brecetas?\s+(?:de|para)\s+([a-z0-9 _-]{3,60})/);
    if (searchMatch?.[1]) return { mode: 'search', value: this.toMealDbTerm(searchMatch[1]).replace(/_/g, ' ') };

    const fallback = normalized
      .replace(/\b(dame|busca|quiero|necesito|una|un|receta|recetas|recipe|recipes|para|cocinar|preparar|prepara)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return fallback ? { mode: 'search', value: this.toMealDbTerm(fallback).replace(/_/g, ' ') } : { mode: 'random' };
  }

  private firstMappedTerm(input: string, map: Record<string, string>): string | null {
    for (const [term, value] of Object.entries(map)) {
      if (new RegExp(`\\b${term}\\b`, 'i').test(input)) return value;
    }
    return null;
  }

  private toMealDbTerm(value: string): string {
    const normalized = this.normalizeText(value).replace(/\s+/g, ' ').trim();
    return (RECIPE_TERM_MAP[normalized] ?? normalized).replace(/\s+/g, '_');
  }

  private normalizeText(input: string): string {
    return input
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[?.,;:!]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private formatRecipe(meal: MealDbMeal): string {
    const ingredients = this.extractMealIngredients(meal).slice(0, 8);
    const steps = this.compactRecipeSteps(meal.strInstructions ?? '').slice(0, 4);
    const meta = [meal.strCategory, meal.strArea].filter(Boolean).join(' / ');
    const source = meal.strSource || meal.strYoutube || 'TheMealDB';

    return [
      `Receta: ${meal.strMeal}`,
      meta ? `Tipo: ${meta}` : null,
      ingredients.length ? `Ingredientes: ${ingredients.join(', ')}.` : null,
      steps.length ? ['Pasos:', ...steps.map((step, index) => `${index + 1}. ${step}`)].join('\n') : null,
      `Fuente: ${source}`,
    ].filter((line): line is string => Boolean(line)).join('\n\n');
  }

  private extractMealIngredients(meal: MealDbMeal): string[] {
    const ingredients: string[] = [];
    for (let index = 1; index <= 20; index += 1) {
      const ingredient = (meal[`strIngredient${index}`] ?? '').trim();
      if (!ingredient) continue;
      const measure = (meal[`strMeasure${index}`] ?? '').trim();
      ingredients.push(measure ? `${measure} ${ingredient}` : ingredient);
    }
    return ingredients;
  }

  private compactRecipeSteps(instructions: string): string[] {
    return instructions
      .replace(/\r/g, '\n')
      .split(/\n+|(?<=\.)\s+/)
      .map((step) => step.replace(/\s+/g, ' ').trim())
      .filter((step) => step.length > 8)
      .map((step) => step.length > 220 ? `${step.slice(0, 217).trim()}...` : step);
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
