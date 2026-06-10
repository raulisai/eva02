#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, '..', 'references', 'public_api_catalog.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const args = parseArgs(process.argv.slice(2));

if (args.help || args.h || Object.keys(args).length === 0) {
  usage();
  process.exit(0);
}

if (args.list) {
  listApis(args.category);
} else if (args.search) {
  searchApis(String(args.search));
} else if (args.show) {
  showApi(String(args.show));
} else if (args.endpoint) {
  showEndpoint(String(args.endpoint));
} else if (args.snippet) {
  printSnippet(String(args.snippet));
} else if (args.call) {
  const endpoint = findEndpoint(String(args.call));
  const url = buildUrl(endpoint, collectParams(args));
  await callUrl(url, Boolean(args.raw));
} else if (args.probe) {
  await probe(String(args.probe), Boolean(args.raw));
} else {
  usage();
}

function usage() {
  console.log([
    'Usage:',
    '  node public_api_catalog.mjs --list [--category weather]',
    '  node public_api_catalog.mjs --search "books"',
    '  node public_api_catalog.mjs --show open-meteo-forecast',
    '  node public_api_catalog.mjs --endpoint open-meteo-forecast.forecast.daily',
    '  node public_api_catalog.mjs --call frankfurter.fx.rate --param base=USD --param quote=MXN',
    '  node public_api_catalog.mjs --snippet themealdb.meal.search',
    '  node public_api_catalog.mjs --probe all',
  ].join('\n'));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (key === 'param') {
      parsed.param = parsed.param || [];
      if (next && !next.startsWith('--')) {
        parsed.param.push(next);
        index += 1;
      }
      continue;
    }
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function listApis(category) {
  const rows = catalog.apis
    .filter((api) => !category || api.category === category)
    .map((api) => `${api.id}\t${api.category}\t${api.auth}\t${api.name}`);
  console.log(rows.join('\n'));
}

function searchApis(query) {
  const needle = query.toLowerCase();
  const rows = catalog.apis
    .filter((api) => JSON.stringify(api).toLowerCase().includes(needle))
    .map((api) => `${api.id}\t${api.category}\t${api.name} - ${api.description}`);
  console.log(rows.join('\n') || `No API matched "${query}".`);
}

function showApi(id) {
  const api = catalog.apis.find((item) => item.id === id);
  if (!api) throw new Error(`Unknown API: ${id}`);
  console.log(JSON.stringify(api, null, 2));
}

function showEndpoint(key) {
  const endpoint = findEndpoint(key);
  console.log(JSON.stringify(endpoint, null, 2));
}

function findEndpoint(key) {
  const parts = key.split('.');
  if (parts.length < 2) throw new Error('Endpoint key must be api-id.endpoint-id');
  const apiId = parts.shift();
  const endpointId = parts.join('.');
  const api = catalog.apis.find((item) => item.id === apiId);
  if (!api) throw new Error(`Unknown API: ${apiId}`);
  const endpoint = api.endpoints.find((item) => item.id === endpointId);
  if (!endpoint) throw new Error(`Unknown endpoint: ${key}`);
  return { api, endpoint };
}

function collectParams(input) {
  const params = {};
  for (const item of input.param || []) {
    const splitAt = item.indexOf('=');
    if (splitAt < 1) throw new Error(`Bad --param value "${item}". Use key=value.`);
    params[item.slice(0, splitAt)] = item.slice(splitAt + 1);
  }
  return params;
}

function buildUrl({ endpoint }, overrideParams = {}) {
  const params = { ...(endpoint.params || {}), ...overrideParams };
  return endpoint.url_template.replace(/\{([^}]+)\}/g, (_match, key) => {
    if (!(key in params)) throw new Error(`Missing param: ${key}`);
    return encodeURIComponent(String(params[key]));
  });
}

async function callUrl(url, raw = false) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'EVA-public-apis-skill/0.1' },
    signal: AbortSignal.timeout(10000),
  });
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  if (raw || !contentType.includes('json')) {
    console.log(body.slice(0, 8000));
    return;
  }
  console.log(JSON.stringify(JSON.parse(body), null, 2).slice(0, 8000));
}

async function probe(target, raw = false) {
  const targets = target === 'all'
    ? catalog.apis.flatMap((api) => api.endpoints.map((endpoint) => ({ api, endpoint })))
    : [findEndpoint(target)];
  const results = [];
  for (const item of targets) {
    const key = `${item.api.id}.${item.endpoint.id}`;
    const started = Date.now();
    try {
      const response = await fetch(item.endpoint.sample_url, {
        headers: { 'User-Agent': 'EVA-public-apis-skill/0.1' },
        signal: AbortSignal.timeout(12000),
      });
      const text = await response.text();
      results.push({
        key,
        ok: response.ok,
        status: response.status,
        ms: Date.now() - started,
        bytes: text.length,
        content_type: response.headers.get('content-type') || '',
      });
    } catch (error) {
      results.push({ key, ok: false, error: error.message, ms: Date.now() - started });
    }
    if (targets.length > 1) await sleep(150);
  }
  if (raw) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const result of results) {
    const status = result.ok ? 'OK' : 'FAIL';
    const detail = result.ok ? `HTTP ${result.status}, ${result.bytes} bytes, ${result.ms}ms` : result.error;
    console.log(`${status}\t${result.key}\t${detail}`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) process.exitCode = 1;
}

function printSnippet(key) {
  const item = findEndpoint(key);
  const url = buildUrl(item);
  console.log(`const url = ${JSON.stringify(url)};
const res = await fetch(url, { headers: { 'User-Agent': 'EVA-public-apis-skill/0.1' } });
if (!res.ok) throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);
const text = await res.text();
const data = (res.headers.get('content-type') || '').includes('json') ? JSON.parse(text) : text;
console.log(data);`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
