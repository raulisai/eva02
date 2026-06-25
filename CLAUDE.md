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

## Dev Studio — máquina Docker dedicada por agente
Cada agente del Dev Studio levanta **su propia máquina Docker** con una imagen pre-horneada según su rol. Los roles de código (`backend`/`frontend`/`testing`, `CODE_ROLES` en [dev-orchestrator.service.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/dev-studio/dev-orchestrator.service.ts)) corren **Claude Code** dentro de su máquina; PM/architect/reviewer siguen razonando en la API (`ModelRouterService`) pero también bootean una máquina base liviana (inspeccionable por terminal).

**Imágenes por rol** ([agent-machines.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/dev-studio/agent-machines.ts), Dockerfiles en `docker/agents/`):

| Imagen | Rol(es) | Tooling pre-horneado |
|---|---|---|
| `eva-agent-base` | architect, project_manager, reviewer, deployment | claude · git · ripgrep · jq |
| `eva-agent-backend` | backend | base + python · php · go · postgres-client |
| `eva-agent-frontend` | frontend | base + pnpm · yarn · next · vite · typescript |
| `eva-agent-testing` | testing | base + playwright(+browsers) · vitest · jest · pytest |

```bash
./docker/agents/build.sh            # base PRIMERO, luego backend/frontend/testing (FROM base)
./docker/agents/build.sh backend    # solo base + backend
```
- Resolución de imagen: `EVA_AGENT_IMAGE_<ROL>` → imagen del rol → `EVA_AGENT_BASE_IMAGE`/`eva-agent-base` → legacy `eva-claude-sandbox` (primera que exista localmente). Sin ninguna, el boot reporta error pidiendo construirla.
- **Boot eager**: al registrar un agente en la iteración, `ensureAgentAndMachine` (orquestador) llama `ClaudeCodeRunnerService.bootMachine()` → contenedor persistente **por agente** (keyed por `dev_agents.id`), credencial inyectada por env si existe, graba `runtime`/`container_id`/`metadata.machine` y emite `dev.agent.machine` (booting→ready/failed). La máquina vive toda la sesión; se destruye en cancel (`shutdownSessionMachines`).
- `ClaudeCodeRunnerService` ([claude-code-runner.service.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/dev-studio/claude-code-runner.service.ts)) corre `claude -p … --output-format stream-json` vía `docker exec` **dentro de la máquina del agente** (`machineKey`), reusando su toolchain y `/work` entre tareas del rol. El token se inyecta vía `-e CLAUDE_CODE_OAUTH_TOKEN`/`-e ANTHROPIC_API_KEY` **sin valor en argv** y nunca se loguea.
- UI: `agent-detail-panel` muestra la máquina (imagen + up/apagada + tooling) y el tab Terminal abre la máquina viva aunque no haya tarea activa; botón "Levantar máquina ahora" → `POST sessions/:id/agents/:role/machine/boot`.
- Credencial por org en `org_integrations` (kind=`credential`, provider=`claude_code`), secreto = `{ method: 'oauth'|'api_key'|'org', token }`. Foco: token de suscripción OAuth (`claude setup-token`).
- Provisioning primera vez: el orquestador crea un human task `claude_code_auth` (instructions.kind) → la UI `ClaudeCodeAuthPanel` ofrece los 3 métodos; al guardar (`POST sessions/:id/claude-code/credential`) se verifica el human task y se reanuda el tick.
- `EVA_CLAUDE_SANDBOX_IMAGE` — override de la imagen legacy de fallback.

### Backing GitHub (repo real por sesión, migración 041)
Todo el trabajo se versiona en **un repositorio GitHub**. Token a nivel org en `org_integrations` (kind=`credential`, provider=`github`; PAT fine-grained con `contents:write` + `pull_requests:write`) — leído por `GithubService` ([github/github.service.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/dev-studio/github/github.service.ts)), nunca logueado.
- **Rama por agente con su nombre**: cada tarea de código clona el repo en el `/work` de la máquina del agente y hace `checkout -B agent/<nombre>/iter-N-<slug>` desde `origin/develop`, con **identidad git por agente** (autor por commit → se ve quién hizo cada cambio). Tras correr Claude: commit + push.
- **PR → develop, aprobado por el arquitecto**: cada agente abre un PR `feature → develop`; el Architect (`reviewPullRequest`) lo aprueba (squash-merge a develop) o pide cambios. `dev_merge_proposals` registra el PR real (`pr_number/url/head_sha/kind`).
- **Release → prod con tu aprobación**: al completar los goals se abre `develop → main` (kind=`release`) y se crea una **approval** (Approval Engine, level 2, `dev_studio.release_merge`); al aprobarla en el panel de Approvals se mergea a `main` y la sesión queda `completed`. El botón directo de approve/reject del panel de PRs **rehúsa** releases (solo Approvals).
- Sin token GitHub → human task `github_connect`. La sesión guarda `repo_url/repo_owner/repo_name/base_branch/integration_branch` (`develop`). UI: indicador de fase, panel de conexión de repo, visor de código solo-lectura (árbol + archivo + diffs de PR) y tarjeta GitHub por agente.

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
