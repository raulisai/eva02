# EVA Compact Project Map

Purpose: Terse seed memory for agents working in `/Users/djoker/code/eva02`. Follow the closed-loop living documentation and self-improvement system detailed in [improvement_loop.md](file:///Users/djoker/code/eva02/docs/improvement_loop.md).

Key Documentation References:
- [architecture.md](file:///Users/djoker/code/eva02/docs/architecture.md) (High level system structure)
- [process_flows.md](file:///Users/djoker/code/eva02/docs/process_flows.md) (System Mermaid flows & sequences)
- [implementation_guide.md](file:///Users/djoker/code/eva02/docs/implementation_guide.md) (Multi-tenancy, RLS, env vars)
- [project_sections.md](file:///Users/djoker/code/eva02/docs/project_sections.md) (Syllabus & codebase module map)
- [backlog.md](file:///Users/djoker/code/eva02/docs/backlog.md) (Living backlog / improvements list)

## Hard Rules


- Multi-tenant: every table/query must carry `org_id`; service-role Supabase queries need explicit `.eq('org_id', orgId)` or equivalent scoped write payload.
- RLS: new tables require migration + RLS policy. AGENTS says policies live in `supabase/migrations/014_rls_policies.sql`; reality also has later RLS/policy migrations (`015`, `016`, `019`, `021`, `022`, `023`, `027`). Reconcile before adding schema.
- Secrets: never commit or expose secrets. Use env/secret manager. Dashboard may send secrets; reads must return masked hints only.
- Approvals: money/production/data/destructive actions route through Approval Engine with `action_hash` + `nonce`.
- Tests: deliver/update tests with behavior changes; keep build/lint/test green as scope allows.
- Destructive migrations/deploy/secrets changes need explicit user approval.

## Repo Shape

- Root npm workspaces: `apps/*`, `packages/*`.
- `apps/eva-core`: NestJS API, port `3000`, dotenv loaded in `src/main.ts`, global validation pipe, Helmet, CORS default `http://localhost:3001`.
- `apps/eva-dashboard`: Next.js 14 dashboard, port `3001`, Supabase SSR, Tailwind/shadcn-style components.
- `packages/browser-runtime`: Playwright runtime used by core browser module.
- `packages/mcp-adapters`: MCP adapter/manager package.
- `packages/skill-runtime`: runtime skill manifests/instructions/tests.
- `supabase/migrations`: SQL migrations currently `001` through `033`.
- `docker`: Redis/Postgres local helpers; Supabase cloud remains expected DB in AGENTS.
- `.agents/skills`: repo-local agent skills, including this seed.

## Commands

- Root: `npm run build`, `npm test`, `npm run test:e2e`, `npm run lint`, `npm run docs:check` (verifies project-map freshness against migrations/controllers).
- Core: `cd apps/eva-core && npm test`; e2e `npm run test:e2e`; real RLS add `RLS_TEST=true npm run test:e2e`; dev `npm run start:dev`.
- Core agent evals: `cd apps/eva-core && npm run eval:agent` runs deterministic golden tasks from `evals/golden-tasks.json`.
- Dashboard: `cd apps/eva-dashboard && npm run dev`; test `npm test`; lint `npm run lint`; build `npm run build`.
- Infra: `docker compose up -d redis`; only run migrations/deploy/destructive actions with approval.

## Core App Wiring

`apps/eva-core/src/app.module.ts` imports:

- `AuthModule`: Supabase JWT via custom Passport strategy; global app guard is throttler, auth guard is module-level pattern.
- `DatabaseModule`: `DatabaseService` exposes service-role `admin` and `forUser(jwt)` RLS client.
- `EventsModule`: Redis Streams `eva:events`, consumer group `eva-core`, persists task events.
- `TasksModule`: CRUD/status state machine.
- `GatewayModule`: Socket.io `/eva`; validates token via Supabase and resolves `org_id` from `users`.
- `HealthModule`: public `GET /health`.
- `MemoryModule`: memories + pgvector search RPC.
- `ModelRouterModule`: billing/model routing + token logs.
- `IntentRouterModule`: classify/list intent routes.
- `PlannerModule`: plan generation endpoint.
- `ToolRouterModule`: tool routing/catalog.
- `DevControlModule`: projects/dev_tasks/Claude sessions/build/test/roadmap endpoints.
- `BrowserModule`: Playwright browser sessions + integration browser flows.
- `CommunicationModule`: accounts/conversations/messages/notifications/Telegram webhook; records Telegram final outbound messages with `task_id` and infers short praise/correction as agent feedback for the latest outbound task in that conversation.
- `IntegrationsModule`: org integrations, MCP connections, credential/model/channel tests.
- `AgentModule`: agent loop/runner, skill library, sandbox, media, research, Gmail/Calendar/Drive, soul, schedule, behavior patterns.
- Agent intelligence telemetry/flywheels: `AgentTrajectoryService` persists `agent_trajectories` checkpoints/finals; `AgentIntelligenceService` handles plan state helpers, replay examples, ask_user persistence/timeouts, token/tool/network safety limits, security review, memory consolidation, self-improvement digest, heartbeat task creation, and skill embeddings. Periodic autonomy is seeded as visible `scheduled_jobs` rows with `payload.system_job='agent_intelligence_autonomy'`; the runner executes those tasks internally without a model call. `ProfileContextBuilderService` builds compact/full prompt context from structured Profile Hub data with legacy `cowork_context` fallback; `GET /agent/metrics` reads org-scoped metrics views.
- Agent loop delivery guard: root loop derives explicit user-requested deliverables like generated PDFs and Telegram file sends, raises the step budget to 12 for those tasks, rejects premature `final_answer`, enters a final delivery mode when steps are low, and returns `ok=false` if required delivery is still pending so the runner does not mark the task completed. Multi-phase pipeline retries reuse `task.metadata.pipeline.definition` and completed phase outputs, rerunning only failed/skipped phases.
- Task horizon routing: `agent/tier.ts` exposes `classifyTier` plus `decideTaskHorizon`; the runner persists `task.metadata.task_horizon`, logs `horizon=*`, and injects horizon policy into generic agent-loop context. Modes: `conversation`, `immediate`, `background`, `scheduled`, `standby`, `approval`; scheduled work routes to visible Jobs, standby parks in `waiting_for_input` with long `ask_user` timeouts, and sensitive actions stay in `waiting_for_approval`.
- `ApprovalsModule`: approval request/resolve/validate.
- `WearFastPathModule`: ephemeral watch tokens, request path, policy.
- `JobsModule`: scheduled jobs + scheduler; scheduled job payload is copied into task metadata so system jobs can be audited and routed safely.

## Auth/Tenancy

- `SupabaseJwtStrategy` validates Bearer token with `db.admin.auth.getUser(token)`.
- `orgId` source order: `user.app_metadata.org_id`, then `X-Org-Id` verified against `users`, then single `users` row fallback.
- Dashboard server org context reads `users.org_id` in `apps/eva-dashboard/lib/supabase/org.ts`.
- Dashboard client `coreFetch` sends Bearer token to `NEXT_PUBLIC_EVA_CORE_URL`.

## Task/Event Model

- Task statuses: `pending`, `planning`, `running`, `waiting_for_approval`, `waiting_for_input`, `completed`, `failed`, `cancelled`.
- Transitions: `pending -> planning|cancelled`; `planning -> running|failed|cancelled`; `running -> waiting_for_approval|waiting_for_input|completed|failed|cancelled`; `waiting_for_approval|waiting_for_input -> running|completed|failed|cancelled`; terminal statuses can reset to `pending`.
- Missing data/setup/forms use `waiting_for_input`, not approval. `AgentIntelligenceService.askUser(...)` accepts configurable `timeoutMinutes` (clamped to 1 minute through 7 days) so tasks can pause for hours/days without being treated as crashed work.
- `TasksRepository` is service-role Supabase and must filter by `org_id`; watch `findStuck(...)`, currently cross-org by age/status and should be handled carefully.
- `EventBusService.publish` writes Redis stream and persists `task_events` when `taskId` exists.
- Event types include task lifecycle/log/step/media/form/setup, approvals, dev tasks, browser screenshots, communication, `agent.feedback.inferred`, wear fast path/tokens.
- `task.waiting_input` is emitted when the loop uses `ask_user`; replies from the same user fill `agent_input_requests` and requeue the waiting task.

## Main HTTP/WS Surface

- Public: `GET /health`, `POST /communication/webhooks/telegram/:orgId`.
- Tasks: `POST /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id/status`.
- Agent learning/metrics: `POST /agent/feedback` records explicit user reaction/rating for a task and reweights skill stats/graph selections; `GET /agent/metrics` returns trajectory/tool/goal/defense/skill/efficiency metrics for `req.user.orgId`.
- Approvals: `POST /approvals/request`, `POST /approvals/:id/approve|reject|validate`.
- Jobs: `GET/POST /jobs`, `GET /jobs/:id`, `POST /jobs/:id/pause|resume`, `DELETE /jobs/:id`.
- Memory: `POST /memories`, `POST /memories/search`, `POST /memories/recall`, `GET /memories/:id`.
- Intent/planner/tool/model: `/intent/classify`, `/intent/routes`, `/planner/plan`, `/tool-router/route`, `/tool-router/tools`, `/billing/stats`.
- Browser: `/browser/open`, `/browser/sessions/:id/{screenshot,click,type,extract-text,extract-table,wait,close,prepare-action,status}`.
- Integrations: `/integrations`, `/integrations/mcp/connections`, credential/model/channel tests, Google/WhatsApp/Uber/Rappi browser flows; browser-backed integration controllers live at `/integrations/google-web`, `/integrations/whatsapp`, `/integrations/uber`, and `/integrations/rappi`.
- Soul/private context: `POST /agent/soul/private-context` stores legacy encrypted user-only context for model prompting.
- Profile Hub: `/agent/profile` exposes `GET /overview`, `POST /facts`, `POST /private-items`, `POST /private-items/:id/reveal`, and suggestion accept/dismiss endpoints for structured user profile data and encrypted vault items.
- Dev control: `/dev-control/projects`, `/dev-control/dev-tasks`, `/dev-control/claude-code/sessions`, build/test runs, roadmap suggestion.
- Wear: `/wear-fast-path/token`, `/wear-fast-path/request`, `/wear-fast-path/policy`.
- WebSocket: Socket.io namespace/path `/eva`, has `ping`, auth token checked in gateway.

## Supabase Schema Groups

Migration order observed: `001_extensions`, `002_orgs_users`, `003_tasks`, `004_events`, `005_memories`, `006_intent_routes`, `007_communication`, `008_skills`, `009_browser`, `010_dev_manager`, `011_wear_fast_path`, `012_nodes_devices`, `013_approvals`, `014_rls_policies`, `015_wear_ui`, `016_integrations_soul_artifacts`, `017_credentials_skill_seed`, `018_tasks_schema_align`, `019_fix_missing_rls_and_grants`, `020_soul_v2`, `021_schedule_places_patterns`, `022_scheduled_jobs`, `023_token_logs`, `024_fix_billing_stats_rpc`, `025_add_task_id_to_token_logs`, `026_fix_task_events_event_nullable`, `027_skill_learning_graph`, `028_agent_intelligence_metrics`, `029_agent_intelligence_flywheels`, `030_capability_gaps`, `031_soul_private_context`, `032_agent_tier_step_settings`, `033_profile_hub`, `034_skill_docs`.

- Identity/org: `organizations`, `users`.
- Tasks/events: `tasks`, `task_events`; `014` references `task_steps` but no `CREATE TABLE` was found in current scan.
- Memory/soul/profile: `memories`, `memory_embeddings`, `agent_souls`, `profile_todos`, `profile_notes`, `profile_goals`, `profile_private_items`, `profile_suggestions`, `profile_private_access_logs`; RPC `match_memories`. `agent_souls` keeps agent identity and legacy persona_context. Profile Hub tables own user todos/notes/goals and encrypted private vault items; Data API grants expose only private hints, never `profile_private_items.ciphertext`.
- Routing/planning/tools/agent intelligence: `intent_routes`, `skills`, `skill_versions`, `skill_files`, `tools`, `tool_calls`, `skill_usage_stats`, `skill_graph_edges`, `skill_selection_events`, `agent_trajectories`, `skill_embeddings`, `agent_input_requests`, `agent_runtime_artifacts`, `org_agent_settings`; `org_agent_settings.max_steps_by_tier` controls safe agent-loop step budgets by tier; views `agent_tool_success_metrics`, `agent_goal_success_metrics`, `agent_defense_metrics`, `agent_skill_funnel_metrics`, `agent_task_efficiency_metrics`.
- Browser: `browser_profiles`, `browser_sessions`, `browser_screenshots`, `browser_action_preparations`.
- Dev manager: `projects`, `dev_tasks`, `claude_code_sessions`, `build_runs`, `test_runs`, `code_reviews`, `roadmap_items`.
- Wear/devices: `wear_sessions`, `wear_tokens`, `wear_fast_path_logs`, `fast_path_policies`, `wear_capabilities`, `wear_directives`, `wear_form_responses`, `wear_sensor_consents`, `nodes`, `node_capabilities`, `devices`.
- Communication/integrations: `communication_channels`, `communication_accounts`, `conversations`, `messages`, `notifications`, `org_integrations`, `mcp_connections`. Telegram outbound file sends compress oversized native videos with `ffmpeg` before applying the 50 MB Bot API limit. MCP HTTP/SSE tests detect OAuth-required 401/403 responses and keep tools hidden until auth is connected.
- Artifacts/schedule/behavior/billing: `artifacts`, `schedule_events`, `known_places`, `location_visits`, `behavior_patterns`, `scheduled_jobs`, `token_logs`; RPC `get_billing_stats`. Internal autonomy wakeups use `scheduled_jobs.payload.system_job='agent_intelligence_autonomy'` and remain operator-visible/pausable in the Jobs dashboard.

## Dashboard Map

- App routes under `apps/eva-dashboard/app`: login, redirect root, dashboard layout, tasks, approvals, artifacts, billing, events, jobs, logs, mcp, nodes, playground, profile, skills, soul.
- `middleware.ts` refreshes Supabase auth with `getUser()`, redirects unauthenticated users to `/login`, authenticated root/login users to `/tasks`.
- API client: `lib/core-api.ts` uses client Supabase session and Bearer token.
- Server org context: `lib/supabase/org.ts` gets `users.org_id`; keep org-scoped Supabase reads.
- UI components: `components/tasks`, `approvals`, `billing`, `events`, `jobs`, `mcp`, `nodes`, `playground`, `profile`, `skills`, `soul`, `settings`, `layout`, `ui`. Task detail renders per-phase progress from `task.metadata.pipeline` above raw metadata; the existing retry action resets the same task to `pending`, letting core resume failed/skipped pipeline phases without rerunning completed ones. Soul editor is now agent identity only; `/profile` is the user Profile Hub with relationship cards, profile context, todos, notes, goals, schedule preview, and encrypted private vault reveal through `/agent/profile`. Playground final answers have thumbs feedback wired to `POST /agent/feedback`; Topbar polls public `/health` to show core/sandbox readiness.

## Local Drift / Watchlist

- AGENTS/README migration lists are stale versus actual `001-033`.
- AGENTS says RLS policies live exclusively in `014_rls_policies.sql`, but later migrations include policy creation; decide convention before adding more tables.
- `014_rls_policies.sql` references `task_steps`; current migration scan did not find `CREATE TABLE task_steps`.
- `TasksRepository.findStuck` lacks an `org_id` argument/filter; may be intended system-wide but violates the written non-negotiable unless bounded elsewhere.
- Many existing files are modified in the worktree; do not revert user changes.
