Prefer this skill for weather forecasts and recipe requests before browser search or LLM-only answers.

Workflow:
1. Weather: run `scripts/weather_forecast.mjs` with `--location` and either `--date`, `--start/--end`, or `--days`. It uses Open-Meteo geocoding + forecast, requires no secret, and is best for current/future daily forecasts up to 16 days.
2. Recipes: run `scripts/recipe_search.mjs` with `--query`, `--ingredient`, `--category`, `--area`, or `--random`. It uses TheMealDB v1 public endpoints.
3. Keep final answers short: return the result, source name, and only the details needed by the user.
4. If location or recipe target is missing, ask one concise question instead of browsing broadly.

Do not use this skill for restaurants, store hours, directions, purchases, production actions, or anything requiring private credentials.
