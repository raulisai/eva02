#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  usage();
  process.exit(0);
}

const request = getRecipeRequest(args);
if (!request) {
  usage();
  process.exit(1);
}

const limit = Math.min(toPositiveInt(args.limit || '1', 'limit'), 5);
const { meals, sources } = await fetchMeals(request, limit);
if (!meals.length) throw new Error('No recipes found for that request.');

const result = {
  provider: 'TheMealDB',
  mode: request.mode,
  value: request.value,
  meals: meals.map(compactMeal),
  sources,
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatMeals(result));
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
  console.log('Usage: node recipe_search.mjs [--query "Arrabiata" | --ingredient chicken_breast | --category Seafood | --area Mexican | --random] [--limit 1] [--json]');
}

function getRecipeRequest(input) {
  if (input.random) return { mode: 'random' };
  if (input.ingredient) return { mode: 'ingredient', value: toMealDbTerm(input.ingredient) };
  if (input.category) return { mode: 'category', value: input.category };
  if (input.area) return { mode: 'area', value: input.area };
  if (input.query) return { mode: 'search', value: input.query };
  return null;
}

async function fetchMeals(request, limit) {
  const sources = [];
  if (request.mode === 'random') {
    const url = 'https://www.themealdb.com/api/json/v1/1/random.php';
    sources.push(url);
    return { meals: [await firstMeal(url)].filter(Boolean), sources };
  }

  if (request.mode === 'search') {
    const url = new URL('https://www.themealdb.com/api/json/v1/1/search.php');
    url.searchParams.set('s', request.value);
    sources.push(url.toString());
    const data = await fetchJson(url);
    return { meals: (data.meals || []).slice(0, limit), sources };
  }

  const url = new URL('https://www.themealdb.com/api/json/v1/1/filter.php');
  url.searchParams.set(request.mode === 'ingredient' ? 'i' : request.mode === 'category' ? 'c' : 'a', request.value);
  sources.push(url.toString());
  const data = await fetchJson(url);
  const summaries = (data.meals || []).slice(0, limit);
  const meals = [];
  for (const summary of summaries) {
    const lookup = new URL('https://www.themealdb.com/api/json/v1/1/lookup.php');
    lookup.searchParams.set('i', summary.idMeal);
    sources.push(lookup.toString());
    const meal = await firstMeal(lookup);
    if (meal) meals.push(meal);
  }
  return { meals, sources };
}

async function firstMeal(url) {
  const data = await fetchJson(url);
  return data.meals?.[0] || null;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
  return response.json();
}

function compactMeal(meal) {
  return {
    id: meal.idMeal,
    name: meal.strMeal,
    category: meal.strCategory,
    area: meal.strArea,
    ingredients: ingredientsFor(meal).slice(0, 10),
    steps: stepsFor(meal.strInstructions || '').slice(0, 5),
    source: meal.strSource || meal.strYoutube || 'TheMealDB',
  };
}

function ingredientsFor(meal) {
  const ingredients = [];
  for (let index = 1; index <= 20; index += 1) {
    const ingredient = String(meal[`strIngredient${index}`] || '').trim();
    if (!ingredient) continue;
    const measure = String(meal[`strMeasure${index}`] || '').trim();
    ingredients.push(measure ? `${measure} ${ingredient}` : ingredient);
  }
  return ingredients;
}

function stepsFor(text) {
  return text
    .replace(/\r/g, '\n')
    .split(/\n+|(?<=\.)\s+/)
    .map((step) => step.replace(/\s+/g, ' ').trim())
    .filter((step) => step.length > 8)
    .map((step) => step.length > 220 ? `${step.slice(0, 217).trim()}...` : step);
}

function formatMeals(result) {
  const chunks = [];
  for (const meal of result.meals) {
    chunks.push([
      `Receta: ${meal.name}`,
      [meal.category, meal.area].filter(Boolean).length ? `Tipo: ${[meal.category, meal.area].filter(Boolean).join(' / ')}` : null,
      meal.ingredients.length ? `Ingredientes: ${meal.ingredients.join(', ')}.` : null,
      meal.steps.length ? ['Pasos:', ...meal.steps.map((step, index) => `${index + 1}. ${step}`)].join('\n') : null,
      `Fuente: ${meal.source}`,
    ].filter(Boolean).join('\n\n'));
  }
  chunks.push('Proveedor: TheMealDB');
  return chunks.join('\n\n---\n\n');
}

function toMealDbTerm(value) {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_');
}

function toPositiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}
