# EVA · Living Backlog & Improvements

This backlog keeps only relevant, actionable improvements. Completed work moves out (it lives in code + CLAUDE.md, not here). Environment-only checks that need live credentials live in §4. Agents must update this file as they resolve items or discover new tasks.

---

## 0a. Dev Studio — Observabilidad + Claude Code para agentes de código (shipped 2026-06-15)
- [x] **Equipo dinámico**: el architect arma el equipo mínimo por complejidad; el orquestador registra en `dev_agents` solo los roles usados; `AgentFlowDiagram` renderiza topología dinámica (no 7 nodos fijos).
- [x] **Logs reales**: `getAgentLogs` leía columnas inexistentes (`step/type/content`) de `task_events` (que tiene `event_type/payload`) — corregido y remapeado. Comms: `getAgentDetail` filtraba por columna `actor` inexistente en `dev_events` — ahora filtra por los `task_id` del rol.
- [x] **Estado en vivo**: panel del agente muestra `status` real (de `dev_agents`) + último paso; tareas fallidas muestran `result_summary`.
- [x] **Claude Code para roles de código** (backend/frontend/testing): imagen `eva-claude-sandbox` (`docker build -t eva-claude-sandbox docker/claude-sandbox`), `ClaudeCodeRunnerService` corre `claude` headless con el token inyectado por env (nunca en argv). Credencial en `org_integrations` (kind=`credential`, provider=`claude_code`) con `{ method, token }`. Provisioning vía human task `claude_code_auth` + UI `ClaudeCodeAuthPanel` (3 métodos: oauth/api_key/org; foco OAuth).

### Pendiente (Claude Code)
- [x] **Terminal en vivo del contenedor Claude Code**: `ClaudeCodeRunnerService` ahora crea un contenedor nombrado y persistente por tarea (`eva-claude-<taskId>`), corre `claude` vía `docker exec`, y expone `attachShellStream` (PersistentShell sobre `docker exec -i`). El gateway (`app.gateway.ts`) cae al runner si `SandboxService` no tiene sesión — el tab Terminal funciona transparente. Contenedor vive 5 min tras terminar (grace) para inspección.
- [ ] **Validar token al guardar**: `saveClaudeCodeCredential` no verifica el token contra la API/CLI antes de aceptar; agregar un probe (`claude --version` headless o llamada ligera).
- [ ] **Terminal post-run**: el tab Terminal se oculta cuando el backing task pasa a `completed` (la query de `activeBackingTask` lo excluye), aunque el contenedor siga vivo en el grace period. Exponer el último backing task id para inspección post-ejecución.
- [ ] **Multi-CLI**: extender el provisioning a otros agentes de código (codex, OpenCloud) reusando el mismo flujo de `claude_code_auth`.
- [ ] **Smoke real**: con imagen construida y token OAuth, correr un goal simple (Snake) y verificar que backend corre en Claude Code, stream de pasos en Logs y artefactos en `/work`.

---

## 0. Reasoning & Agency (shipped 2026-06-14)
- [x] **P1 Semantic trajectory replay**: migration 037, `goal_embedding vector(1536)`, `match_trajectories` RPC, embed on task complete, cosine fallback.
- [x] **P2 Tool alternatives on first ERROR**: `tool-alternatives.ts` inverse-capability map, injected into error observation at step time (parallel + sequential paths).
- [x] **P3 Declarative delivery guard**: `delivery-requirements.ts` replaces regex-per-kind with a `DELIVERY_RULES` table — PDF, Telegram, Email, WhatsApp, Excel, Calendar.
- [x] **P4 Gated deliberation for medium tasks**: `deliberateMediumTask()` in intelligence service, 1 `balanced` call pre-execution, injects strategy brief like `prepareExecution` does for long tasks.
- [x] **P5 Fail-open signals**: `selectToolsForPhase` returns all tools when no domain signals match complex tasks.

---

## 1. Runtime Safety & Observability
Sandbox concurrency stress test and network-compliance telemetry shipped (see [sandbox.service.spec.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/__tests__/sandbox.service.spec.ts) and `recordNetworkExec` in [agent-loop.service.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/agent-loop.service.ts) → `task_events` event_type `sandbox.network_exec`).

- [ ] **Task Horizon UI**: surface `task.metadata.task_horizon` in the dashboard task detail so operators can see why EVA chose immediate/background/scheduled/standby/approval handling.
---

## 2. Profile Hub Roadmap
Tracked in [profile_hub_plan.md](file:///Users/djoker/code/eva02/docs/profile_hub_plan.md).

- [ ] **Fase 3 — Interaction**: direct edit/create for notes/todos/goals/events, drag reorder, dialogs, masking/reveal audit UI for private vault.
- [ ] **Fase 4 — Auto-fill**: structured digester v2, profile/todo/goal/note tools, suggestion inbox UI, realtime updates.

---

## 3. External Validation Queue
These require live credentials/environment and are not code backlog until available.

- [ ] **RLS Verification**: after applying migrations to Supabase, run `RLS_TEST=true npm run test:e2e` and verify `agent_souls.private_context_ciphertext` and `profile_private_items.ciphertext` are unreadable through the authenticated Data API.
- [ ] **Production Docker Check**: on the target Linux host, verify the Docker socket mount and rebuild the enriched sandbox image (`docker build -t eva-sandbox docker/sandbox` — now bundles `bash` + `util-linux` for the PTY and `ipython` for rich tracebacks). Confirm the persistent shell (state across steps, dialog → `terminal_input`) works there.
- [ ] **Live Telegram Media Smoke**: real Telegram webhook media limits, transcription, image analysis, `yt-dlp`, and document send flows with a live bot. Also test inline approval button taps.
- [ ] **Live WhatsApp Visual Smoke**: with a logged-in WhatsApp Web profile, ask “cuáles mensajes tengo sin responder”; verify `whatsapp_read(unanswered_only)` uses screenshot vision for unread color/badges/last-message direction and does not return a generic privacy/capability refusal.
- [ ] **Live Smart Browser Smoke**: run `browser_navigate` on WhatsApp/Uber with an intentionally ambiguous or stale selector path; verify task `browser_memory` records failed/working selectors, autocomplete/listbox options are exposed as clickable targets, a visual diagnostic is emitted after no-progress, and `agent_data_log` stores a reusable `browser:site:<host>` learning.
- [ ] **Live Location + Uber Web Smoke**: from Playground and Wear OS, send "dónde estoy", "cotiza Uber de casa al Zócalo", and "pídeme un Uber al trabajo"; verify browser/Wear permission prompts, `request_context.location` on the task, no guessed location fallback, known place `work` resolution, visible Uber quote screenshot/fare extraction or route-form fallback, route-form validation retries when “Dropoff location” remains empty or only matches generic CDMX/city tokens, geometric first-suggestion selection on Uber autocomplete rows without roles, and `uber.ride.order` approval before any real booking.
- [ ] **Live PDF-To-Telegram Smoke**: end-to-end task that researches, generates a PDF in `/work`, sends it through Telegram, confirms `code_execute` + `telegram_send_file` in the task log, verifies malformed/blank PDFs are rejected before upload, and verifies that missing delivery does not transition to `completed`.
- [ ] **Live Pipeline Smoke**: end-to-end "Crea un informe de ventas, conviértelo a PDF y envíalo por Telegram" — confirm 3 phase logs, parallel wave detection, PDF artifact in `/work`, Telegram delivery.
