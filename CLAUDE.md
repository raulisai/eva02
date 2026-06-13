# EVA — Agentic Platform

Stack: TypeScript · NestJS · Supabase (Postgres + pgvector) · Redis · BullMQ · Playwright · Docker · Next.js

## 🔄 Closed-Loop Living Documentation (MANDATORY)
To minimize context token consumption and avoid documentation drift, **every AI agent** (Claude, Codex, Antigravity, etc.) working on this project **must**:
1. Load the local skill `eva-project-seed` first.
2. Read the high-density documentation files under `docs/` (starting with [architecture.md](file:///Users/djoker/code/eva02/docs/architecture.md)).
3. Follow the closed-loop workflow defined in [improvement_loop.md](file:///Users/djoker/code/eva02/docs/improvement_loop.md).
4. Update relevant documentation in `docs/` and log outstanding items in [backlog.md](file:///Users/djoker/code/eva02/docs/backlog.md) at the end of every task before updating the project seed.

## Non-negotiable rules
- **Multi-tenant**: every table and query MUST filter by `org_id`. Never query without it.
- **RLS**: new tables → add migration AND an RLS policy in `014_rls_policies.sql`.
- **Secrets**: no secrets in code or client; use env vars / secret manager only.
- **Approvals**: money/production/data actions go through the Approval Engine (action_hash + nonce).
- **Tests**: always deliver tests; keep build + lint + test green.
- **Delivery**: explain diff, list touched files, give command to verify.
- **Never** run destructive migrations, deploy, or change secrets without explicit approval.

## App structure
```
apps/eva-core/     NestJS API (this app)
supabase/
  migrations/      SQL migrations, applied in numeric order
docker/            Postgres init scripts
```

## Key modules (eva-core)
| Module | Purpose |
|--------|---------|
| `auth` | Supabase JWT strategy + global JwtAuthGuard |
| `database` | DatabaseService — Supabase admin + per-user client (`forUser(token)`) |
| `events` | EventBusService — Redis Streams (eva:events); validates Redis on startup |
| `tasks` | Task Engine: CRUD + state machine |
| `gateway` | Socket.io WebSocket gateway (`/eva`); verifica token via `supabase.auth.getUser()`, busca `org_id` en tabla `users` |
| `health` | Public GET /health |
| `agent` | AgentRunner (fast-paths) + AgentLoop (bucle agéntico estilo agent-zero) + SandboxService (ejecución de código en Docker) + SkillLibrary (skills reutilizables) |

## Sandbox de código (agent-loop)
El bucle agéntico ejecuta código que el propio modelo escribe (`code_execute`, `terminal_run`, `skill_run`) en un contenedor Docker **por tarea**: `/work` persiste entre pasos, rootfs read-only, sin red, recursos acotados; se destruye al terminar la tarea.

**Shell persistente (PTY vivo, estilo Agent Zero)**: el foreground (terminal/python/bash) corre en un shell de larga vida por sesión (`PersistentShell` en [sandbox-shell.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/sandbox-shell.ts)), así el estado de shell (env, `cd`, venvs, procesos) sobrevive entre pasos — no solo `/work`. Usa `script` (PTY real) en la imagen enriquecida; cae a `sh` pelado si falta.
- Timeouts multi-fase: el comando devuelve `status: 'completed' | 'running' | 'awaiting_input'` en vez de un timeout binario. `running` → reanuda con `terminal_output`. `awaiting_input` (diálogo detectado: `[y/n]`, password…) → responde con `terminal_input`.
- Terminales paralelas: `terminal_run{"session": N}` (0-9) multiplexa shells en el mismo contenedor (ej. server en 1, pruebas en 0).
- `node` corre one-shot sobre el mismo `/work`; `background:true` lanza un proceso detached con log.

```bash
docker build -t eva-sandbox docker/sandbox   # imagen python enriquecida (pandas, requests, numpy…, bash+script para el PTY)
```
- Sin la imagen, cae a `python:3.12-alpine` / `node:20-alpine` / `alpine:3.20`.
- `EVA_SANDBOX_IMAGE` — override de imagen (vacío = forzar fallback alpine).
- `EVA_SANDBOX_ALLOW_NETWORK=true` — permite `code_execute` con red SIN approval (solo dev). En prod, la ejecución con red siempre crea una approval (`sandbox.network_exec`).
- Secrets en código generado: alias `§§secret(provider)` (kind `credential`) — se sustituye al ejecutar y se enmascara en la salida; el modelo nunca ve el valor.
- Smoke test real: `npx ts-node --transpile-only scripts/sandbox-smoke.ts` (requiere Docker).

## Task state machine
```
pending → planning → running → completed
                  ↓          → failed
                  → waiting_for_approval → running | completed | failed
Any non-terminal state → cancelled
```

## Running locally
```bash
cp apps/eva-core/.env.example apps/eva-core/.env   # fill in values
docker compose up -d redis          # postgres está en Supabase cloud
cd apps/eva-core && npm install && npm run start:dev
```

> `main.ts` carga el `.env` via `import 'dotenv/config'` — requerido para que el proceso arranque con las variables correctas.

## Tests
```bash
cd apps/eva-core
npm test             # unit tests
npm run test:e2e     # e2e (mocked DB)
RLS_TEST=true npm run test:e2e   # also runs real Supabase RLS test
```

## Migrations
Apply in order 001 → 002 → 003 → 004 → 005 → 006 → 007 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015.
RLS policies live exclusively in `014_rls_policies.sql`.

### Nombres reales de tablas (Supabase cloud)
| Nombre en código | Tabla real |
|---|---|
| organizations | organizations |
| users | users (`id = auth.uid()`, tiene `org_id`) |
| task_events | task_events |

> Las migraciones `002_orgs_users.sql` y `004_events.sql` usan los nombres correctos. No referenciar `orgs`, `org_members` ni `domain_events` en código nuevo.
