---
estado: diseño
proyecto: EVA
tipo: base-de-datos
---
# 05 · Base de Datos Supabase (Esquema + RLS)

→ [[00 - EVA · Índice Maestro (MOC)|índice]] · anterior [[04 - Escalabilidad y Distribución]]

Los scripts se versionan en `infra/supabase/migrations/` y se aplican **en orden numérico**. Cada [[06 - Plan de Ejecución por Fases|fase]] indica qué migración corre.

> Aplica con: `supabase db push` (CLI) o pega cada script en **Supabase Studio → SQL Editor → Run**. **Nunca** saltes el orden.

---

## Índice de migraciones por fase

| Migración | Contenido | Fase que la usa |
|-----------|-----------|-----------------|
| `001_extensions.sql` | uuid, pgcrypto, vector | Fase 1 |
| `002_orgs_users.sql` | organizations, users (`id=auth.uid()`), devices | Fase 1 |
| `003_tasks.sql` | tasks, task_steps + trigger `set_updated_at` | Fase 1 |
| `004_events.sql` | task_events | Fase 1 |
| `005_memories.sql` | memories, memory_embeddings (pgvector) | Fase 3 |
| `006_intent_routes.sql` | intent_routes | Fase 2 |
| `007_communication.sql` | messages, conversations, notifications | Fase 9 |
| `008_skills.sql` | skills, skill_versions, tools, tool_calls | Fase 10 |
| `009_browser.sql` | browser_sessions, screenshots | Fase 7 |
| `010_dev_manager.sql` | projects, dev_tasks, build/test/reviews, roadmap | Fase 6 |
| `011_wear_fast_path.sql` | wear_sessions, wear_tokens, wear_fast_path_logs, fast_path_policies | Fase 13 |
| `012_nodes_devices.sql` | nodes, node_capabilities | Fase 1 / 5 |
| `013_approvals.sql` | approvals (action_hash + nonce) | Fase 8 |
| `014_rls_policies.sql` | políticas RLS de todas las tablas | tras cada bloque |
| `015_wear_ui.sql` | wear_capabilities, wear_directives, wear_form_responses | Fase 13 |

---

## `001_extensions.sql`
```sql
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists vector;       -- pgvector para memoria semántica
```

## `002_tenancy_users.sql`
```sql
-- Organizaciones (tenant raíz)
create table organizations (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  plan text not null default 'free',
  cost_limit_usd numeric default 50,         -- circuit breaker de costo
  created_at timestamptz default now()
);

-- Usuarios (ligados a Supabase Auth via auth.users.id)
create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  display_name text,
  role text not null default 'member',       -- owner | admin | member
  created_at timestamptz default now()
);

-- Dispositivos (relojes, teléfonos)
create table devices (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  kind text not null,                         -- galaxy-watch | android | ios | web
  label text,
  status text default 'active',
  created_at timestamptz default now()
);

-- Helper: org_id del JWT actual (lo setea Auth como claim)
create or replace function current_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'org_id','')::uuid
$$;

create index on users(org_id);
create index on devices(org_id);
```

## `003_nodes.sql`
```sql
create table nodes (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  node_key text unique not null,              -- credencial rotable (hash)
  type text not null,                         -- desktop | server | browser-worker | dev-worker
  os text,
  status text default 'offline',              -- online | offline
  battery text, cpu text, memory text,
  last_heartbeat timestamptz,
  created_at timestamptz default now()
);

create table node_capabilities (
  node_id uuid references nodes(id) on delete cascade,
  capability text not null,                   -- browser | terminal | claude_code | docker | ...
  primary key (node_id, capability)
);

create index on nodes(org_id);
```

## `004_tasks.sql`
```sql
create table tasks (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references users(id),
  type text not null default 'simple',        -- simple|complex|browser_task|dev_task|...
  status text not null default 'pending',      -- pending|planning|running|waiting_for_approval|completed|failed|...
  intent_route text,                           -- fast_path | core_path
  idempotency_key text,                        -- evita dobles ejecuciones
  payload jsonb default '{}',
  result jsonb,
  trace_id text,                               -- observabilidad distribuida
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (org_id, idempotency_key)
);

create table task_steps (
  id uuid primary key default uuid_generate_v4(),
  task_id uuid references tasks(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  seq int not null,
  description text,
  status text default 'pending',
  tool text, node_id uuid references nodes(id),
  created_at timestamptz default now()
);

create table task_events (
  id bigserial primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  event text not null,                          -- task.created | task.completed | ...
  data jsonb default '{}',
  created_at timestamptz default now()
);

create index on tasks(org_id, status);
create index on task_steps(task_id);
create index on task_events(task_id);
```

## `005_memory.sql`
```sql
create table memories (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references users(id),
  kind text,                                    -- conversation|preference|decision|learning|...
  content text not null,
  importance real default 0.5,                  -- el Memory Service calcula esto
  source text,                                  -- core | fast_path_summary
  created_at timestamptz default now()
);

create table memory_embeddings (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  memory_id uuid references memories(id) on delete cascade,
  embedding vector(1536) not null              -- ajusta dim al modelo de embeddings
);

create index on memories(org_id);
create index on memory_embeddings
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);
```

## `006_approvals.sql`
```sql
create table approvals (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  level int not null,                           -- 0..3
  status text default 'pending',                -- pending|approved|rejected|expired
  action_hash text not null,                    -- sha256(payload) — anti-TOCTOU
  nonce text not null,
  summary text,
  screenshot_ref text,
  requested_by uuid references users(id),
  approved_by uuid references users(id),
  approved_by_2 uuid references users(id),      -- doble aprobación (nivel 3)
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
create index on approvals(org_id, status);
```

## `010_dev_manager.sql`
```sql
create table projects (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  repo_path text, node_id uuid references nodes(id),
  stack text[], status text default 'active',
  main_branch text default 'main',
  dev_command text, test_command text, build_command text
);
create table dev_tasks (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  title text not null,
  status text default 'backlog',                -- backlog|ready|in_progress|waiting_approval|testing|reviewing|done|failed|blocked
  prompt text, diff_summary text, created_at timestamptz default now()
);
create table build_runs ( id bigserial primary key, org_id uuid not null references organizations(id), dev_task_id uuid references dev_tasks(id), ok boolean, output text, created_at timestamptz default now());
create table test_runs  ( id bigserial primary key, org_id uuid not null references organizations(id), dev_task_id uuid references dev_tasks(id), ok boolean, output text, created_at timestamptz default now());
create table code_reviews(id bigserial primary key, org_id uuid not null references organizations(id), dev_task_id uuid references dev_tasks(id), risk text, notes text, created_at timestamptz default now());
create table roadmap_items(id uuid primary key default uuid_generate_v4(), org_id uuid not null references organizations(id), project_id uuid references projects(id), title text, status text default 'todo', priority int);
```

## `011_wear_fast_path.sql`
```sql
create table wear_tokens (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  device_id uuid references devices(id),
  scope text default 'wear_fast_path',
  model text, max_tokens int default 500,
  expires_at timestamptz not null,
  used boolean default false,
  created_at timestamptz default now()
);
create table wear_sessions ( id uuid primary key default uuid_generate_v4(), org_id uuid not null references organizations(id), device_id uuid references devices(id), started_at timestamptz default now(), ended_at timestamptz);
create table wear_fast_path_logs ( id bigserial primary key, org_id uuid not null references organizations(id), device_id uuid references devices(id), request_type text, model text, latency_ms int, tokens_used int, cost_usd numeric, fell_back boolean default false, created_at timestamptz default now());
create table fast_path_policies ( id uuid primary key default uuid_generate_v4(), org_id uuid not null references organizations(id), allowed jsonb, disallowed jsonb, per_session_limit int, per_day_limit int);
create table intent_routes ( id bigserial primary key, org_id uuid not null references organizations(id), text_in text, decision text, created_at timestamptz default now());
```

## `012_experiences_costs.sql`
```sql
create table experiences (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  objective text, plan jsonb, tools_used text[], node_id uuid references nodes(id),
  model text, duration_ms int, cost_usd numeric, errors jsonb, result text,
  user_feedback text, skill_opportunity boolean default false,
  created_at timestamptz default now()
);
create table costs (
  id bigserial primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  scope text,                                   -- task|user|model|skill|agent|embeddings|browser|claude_code|fast_path
  ref_id uuid, amount_usd numeric not null, created_at timestamptz default now()
);
create index on costs(org_id, scope);
```

## `013_audit_log.sql`
```sql
create table audit_log (
  id bigserial primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  actor text,                                   -- user:uuid | node:uuid | agent:name
  action text not null,
  data jsonb default '{}',
  prev_hash text,
  hash text not null,                           -- sha256(data || prev_hash)
  created_at timestamptz default now()
);
-- append-only: sin update ni delete (se refuerza con política RLS en 014)
create index on audit_log(org_id, created_at);
```

## `014_rls_policies.sql` (patrón aplicado a TODAS las tablas)
```sql
-- Habilitar RLS
alter table organizations enable row level security;
alter table users          enable row level security;
alter table tasks          enable row level security;
-- … repetir para CADA tabla con org_id …

-- Política estándar de aislamiento por organización
create policy org_isolation_select on tasks
  for select using (org_id = current_org_id());
create policy org_isolation_mod on tasks
  for all using (org_id = current_org_id())
  with check (org_id = current_org_id());
-- … repetir el par (select + all) para cada tabla …

-- audit_log: solo insertar y leer; nunca update/delete
create policy audit_insert on audit_log
  for insert with check (org_id = current_org_id());
create policy audit_read on audit_log
  for select using (org_id = current_org_id());
-- (no se crean políticas de update/delete ⇒ quedan denegadas)
```

> ⚠️ **Regla de oro:** ninguna tabla con `org_id` debe quedar sin RLS. Antes de cada `git push` corre el checklist de [[03 - Modelo de Seguridad]].

---

➡️ Siguiente: [[06 - Plan de Ejecución por Fases]]
