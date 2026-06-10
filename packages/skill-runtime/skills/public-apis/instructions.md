Prefer this skill when a task can be solved with a safe, read-only public API before browser search or LLM-only answers.

Workflow:
1. Find an API without loading the whole catalog:
   - `node scripts/public_api_catalog.mjs --search "books"`
   - `node scripts/public_api_catalog.mjs --list --category weather`
   - `node scripts/public_api_catalog.mjs --show open-meteo-forecast`
2. Probe before using an endpoint for a new automation:
   - `node scripts/public_api_catalog.mjs --probe open-meteo-forecast.forecast.daily`
   - `node scripts/public_api_catalog.mjs --probe all`
3. Call a catalog endpoint with safe params:
   - `node scripts/public_api_catalog.mjs --call frankfurter.fx.rate --param base=USD --param quote=MXN`
4. Generate a tiny Node fetch snippet:
   - `node scripts/public_api_catalog.mjs --snippet themealdb.meal.search`
5. Weather fast path: run `scripts/weather_forecast.mjs` with `--location` and either `--date`, `--start/--end`, or `--days`.
6. Recipes fast path: run `scripts/recipe_search.mjs` with `--query`, `--ingredient`, `--category`, `--area`, or `--random`.
7. Keep final answers short: return the result, source name, and only the details needed by the user.
8. If a required parameter is missing, ask one concise question instead of browsing broadly.

Safety:
- Only use catalog endpoints marked `GET`.
- Do not use this skill for restaurants, store hours, directions, purchases, production actions, account changes, private data, or anything requiring private credentials.
- Health/finance entries are informational only; never automate medical, legal, financial, emergency, production, or money movement decisions from them.
- Cache repeated calls and keep limits small.
