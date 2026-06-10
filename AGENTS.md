# EVA — Agentic Platform

Stack: TypeScript · NestJS · Supabase (Postgres + pgvector) · Redis · BullMQ · Playwright · Docker · Next.js

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
