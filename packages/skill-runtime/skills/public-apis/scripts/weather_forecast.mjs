#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const location = args.location || args.l || process.env.EVA_DEFAULT_LOCATION;

if (args.help || args.h) {
  usage();
  process.exit(0);
}

if (!location) {
  usage();
  process.exit(1);
}

const start = normalizeDate(args.start || args.date || 'today');
const end = args.end ? normalizeDate(args.end) : addDays(start, toPositiveInt(args.days || '1', 'days') - 1);
const totalDays = inclusiveDayCount(start, end);

if (totalDays < 1 || totalDays > 16) {
  throw new Error('Open-Meteo forecast supports exact daily ranges from 1 to 16 days.');
}

const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
geocodeUrl.searchParams.set('name', location);
geocodeUrl.searchParams.set('count', '1');
geocodeUrl.searchParams.set('language', args.lang || 'es');
geocodeUrl.searchParams.set('format', 'json');

const geocode = await fetchJson(geocodeUrl);
const place = geocode.results?.[0];
if (!place) throw new Error(`No location found for "${location}".`);

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
forecastUrl.searchParams.set('timezone', place.timezone || 'auto');
forecastUrl.searchParams.set('start_date', start);
forecastUrl.searchParams.set('end_date', end);

const forecast = await fetchJson(forecastUrl);
const days = (forecast.daily?.time || []).map((date, index) => ({
  date,
  condition: weatherCodeLabel(forecast.daily.weather_code?.[index]),
  min_c: forecast.daily.temperature_2m_min?.[index],
  max_c: forecast.daily.temperature_2m_max?.[index],
  rain_probability_pct: forecast.daily.precipitation_probability_max?.[index],
  wind_max_kmh: forecast.daily.wind_speed_10m_max?.[index],
}));

const result = {
  provider: 'Open-Meteo',
  place: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
  start,
  end,
  days,
  sources: [geocodeUrl.toString(), forecastUrl.toString()],
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatWeather(result));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function usage() {
  console.log('Usage: node weather_forecast.mjs --location "Ciudad de Mexico" [--date YYYY-MM-DD|today|tomorrow] [--days 3] [--start YYYY-MM-DD --end YYYY-MM-DD] [--json]');
}

function normalizeDate(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === 'today' || normalized === 'hoy') return addDays(new Date().toISOString().slice(0, 10), 0);
  if (normalized === 'tomorrow' || normalized === 'manana' || normalized === 'mañana') {
    return addDays(new Date().toISOString().slice(0, 10), 1);
  }
  if (/^20\d{2}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  throw new Error(`Invalid date "${value}". Use YYYY-MM-DD, today, or tomorrow.`);
}

function addDays(isoDate, offset) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function inclusiveDayCount(startDate, endDate) {
  const startTime = new Date(`${startDate}T00:00:00Z`).getTime();
  const endTime = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.floor((endTime - startTime) / 86_400_000) + 1;
}

function toPositiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
  return response.json();
}

function formatWeather(result) {
  const lines = [`Pronostico ${result.place} (${result.start} a ${result.end})`];
  for (const day of result.days) {
    const temps = Number.isFinite(day.min_c) && Number.isFinite(day.max_c)
      ? `${Math.round(day.min_c)}-${Math.round(day.max_c)} C`
      : 'temperatura n/d';
    const rain = Number.isFinite(day.rain_probability_pct)
      ? `lluvia ${Math.round(day.rain_probability_pct)}%`
      : 'lluvia n/d';
    const wind = Number.isFinite(day.wind_max_kmh)
      ? `viento ${Math.round(day.wind_max_kmh)} km/h`
      : 'viento n/d';
    lines.push(`${day.date}: ${day.condition}; ${temps}; ${rain}; ${wind}`);
  }
  lines.push('Fuente: Open-Meteo');
  return lines.join('\n');
}

function weatherCodeLabel(code) {
  if (code === undefined || code === null) return 'condiciones no especificadas';
  if (code === 0) return 'cielo despejado';
  if ([1, 2, 3].includes(code)) return 'parcialmente nublado';
  if ([45, 48].includes(code)) return 'niebla';
  if ([51, 53, 55, 56, 57].includes(code)) return 'llovizna';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'lluvia';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'nieve';
  if ([95, 96, 99].includes(code)) return 'tormenta';
  return 'condiciones variables';
}
