# EVA · Living Backlog & Improvements

This backlog keeps only relevant, actionable improvements. Completed work moves out (it lives in code + CLAUDE.md, not here). Environment-only checks that need live credentials live in §4. Agents must update this file as they resolve items or discover new tasks.

---

## 0aa. Dev Studio — Robustez de flujo + login Claude Code verificable (shipped 2026-06-19)
**Anti-atasco (P0):**
- [x] **Heartbeat + reconciliación**: `DevOrchestratorService` corre un barrido cada 2 min (`recoverAndSweep`) + uno al boot. Boot: re-encola tareas huérfanas de iteraciones `running` viejas (>15 min) tras crash/reinicio. Heartbeat: re-tickea sesiones `running` sin avance (>3 min). Idempotente (guard + _tick cortocircuitan si hay trabajo vivo). `listStaleRunningSessions/Iterations` + `requeueOrphanedTasks` en `dev-session.service`.
- [x] **`dispatchTaskWaves` con try/finally**: un throw a mitad de wave ya no deja la iteración colgada en `running` — el finally siempre cierra la iteración y re-tickea.
- [x] **Evaluación con outputs reales**: `buildIterationOutputs()` agrega `[role] título → result_summary (branch)` de cada task terminada; reemplaza el `"Wave N completed"` genérico que dejaba al PM ciego y causaba bucles hasta MAX_ITERATIONS.
- [x] **Fix handler muerto**: `updateIterationStatus` ahora publica `sessionId` en `dev.iteration.updated` (el handler del orquestador lo exigía → nunca disparaba).

**Login Claude Code (P1):**
- [x] **Validación de token al guardar**: `verifyToken()` corre `claude -p` 1-turn en contenedor efímero; `POST .../claude-code/credential` rechaza con 400 si el token es claramente inválido (no bloquea por fallos de infra).
- [x] **`verifyAuth()` por máquina**: tras bootear una máquina de código, el orquestador verifica login dentro del contenedor y guarda `metadata.machine.authOk` + emite `dev.agent.machine{auth_ok|auth_failed}`. UI: chip "🔑 logueado / token inválido" en el panel del agente.
- [x] **AUTH_FAILED tipado**: `run()` detecta errores de auth (regex) y los marca; el orquestador reabre el provisioning `claude_code_auth` y re-encola la task en vez de un blocker genérico; `handleAgentFailure` es idempotente respecto al provisioning.

**Debuggability (P2):**
- [x] **`claude.exit` inspeccionable**: cada run de Claude Code emite a `dev_events` su exit (ok/auth_failed/error) con image, container y cola del stderr.
- [x] **IDOR de terminal cerrado**: `sandbox.attach` valida que el key (taskId/agentId) pertenezca al org del socket; `sandbox.input` solo escribe al key ya adjuntado.

**Eficiencia (P3):**
- [x] **Lock distribuido de tick**: `EventBusService.tryLock/releaseLock` (Redis SET NX PX, fail-open) evita doble tick entre instancias.
- [x] **Push por WebSocket**: `events-bridge` ahora difunde los `dev.*` clave; `session-detail` se suscribe y refresca en vivo (poll de respaldo bajado a 15s).
- [x] **Aviso de fallback de imagen**: `bootMachine` emite `fallback` cuando el rol cae a la imagen base por no estar construida la especializada.

### Pendiente
- [ ] **P0 — Reanudación de waves encoladas**: `dispatchQueuedTasks()`/`runWaveFromQueued()` ejecutan tareas recuperadas o reanudadas, pero no cierran la `dev_iteration`, no conservan el DAG, ignoran el booleano de `runAgentTask()` y no disparan el tick final. Un fallo de máquina deja la sesión en `running` y el heartbeat solo agrega `orchestrator.tick`. Unificar este camino con `dispatchTaskWaves()` y cubrir provisioning/restart/fallo total con tests.
- [ ] **P0 — Restaurar scoping multi-tenant en Dev Studio**: la lectura de `dev_iterations` en `runWaveFromQueued()` y la lectura de la iteración actual en `getFlowState()` filtran por `id` pero omiten `.eq('org_id', orgId)`. Corregir ambas y añadir aserciones de tenancy.
- [ ] **P1 — Heartbeat basado en progreso real**: `listStaleRunningSessions()` usa `dev_sessions.updated_at`, pero los ticks/eventos/tareas no actualizan esa fila. Mientras una sesión siga `running`, se vuelve a considerar stale cada 2 min y ensucia la timeline aunque no haya una recuperación posible.
- [ ] **Timeout de pared por iteración en vivo**: hoy solo se recuperan iteraciones colgadas al boot (>15 min); una iteración viva genuinamente colgada se acota por timeouts per-task (claude 10 min). Evaluar un tope duro por iteración.
- [ ] **verifyAuth periódico**: hoy se chequea login al bootear; añadir re-check cuando un run devuelve AUTH_FAILED a mitad de sesión.

## 0b. Dev Studio — Diagrama de flujo vivo + rol full_stack (shipped 2026-06-19)
- [x] **Topología no lineal**: `computeEdges(visible, assigner)` arma un grafo de comunicación (PM↔architect bidireccional con arista "reporta" dashed; el `assigner` = architect, o PM si no hay architect, reparte a los devs; devs→reviewer/human; reviewer→PM loop). Ya no es una pirámide fija.
- [x] **Estado vivo por agente**: endpoint `GET sessions/:id/flow` → `getFlowState()` devuelve por agente la tarea actual (`currentTaskTitle/Status`), `stuckMs` (tiempo sin avance), los `handoffs` (última instrucción por arista from→to con timestamp) y un `stuck` (dónde está atascado: agente bloqueado/fallido → esperando humano → agente sin avance >90s). El diagrama (poll 3s) muestra la tarea en cada nodo, la última instrucción como etiqueta de cada flecha (+ "hace Xm", full text en `<title>`), banner de atasco arriba y resalta en ámbar el nodo atascado con ⏱.
- [x] **Rol `full_stack`**: nuevo rol de código end-to-end (types, `AGENT_SYSTEM_PROMPTS`, `CODE_ROLES`, display name, imagen `eva-agent-backend`, vocabulario + guía del architect: proyecto sencillo con server+UI → un solo full_stack; backend puro → backend; frontend puro → frontend). UI: emoji 🧰, label, tema teal, tier 2.

### Pendiente (diagrama)
- [ ] **Handoffs reverse reales**: hoy la arista architect→PM "reporta" es estructural (no lleva instrucción real). Cuando exista un canal de mensajes agente→agente, alimentar también las aristas de retorno con su último mensaje.
- [ ] **Imagen full_stack dedicada**: hoy reusa `eva-agent-backend` (tiene node+python+php+go pero no pnpm/next cache); crear `eva-agent-fullstack` si se nota lento en proyectos con build de frontend pesado.

## 0. Dev Studio — Máquina dedicada por agente (shipped 2026-06-19)
- [x] **Imagen Docker por rol**: imágenes pre-horneadas bajo `docker/agents/` — `eva-agent-base` (claude·git·ripgrep·jq, usada por architect/PM/reviewer/deployment) y las especializadas `eva-agent-backend` (python·php·go·postgres-client), `eva-agent-frontend` (pnpm·yarn·next·vite·ts), `eva-agent-testing` (playwright+browsers·vitest·jest·pytest). Build ordenado: `./docker/agents/build.sh` (la base primero, las demás `FROM eva-agent-base`).
- [x] **Registry de imágenes**: `agent-machines.ts` mapea rol → `{ image, memory, cpus, toolingLabel }` con overrides `EVA_AGENT_IMAGE_<ROL>` / `EVA_AGENT_BASE_IMAGE`; `imageCandidates()` resuelve rol → base → legacy (`eva-claude-sandbox`).
- [x] **Boot eager por agente**: el orquestador (`ensureAgentAndMachine`) levanta la máquina del agente al registrarlo en la iteración; `ClaudeCodeRunnerService.bootMachine()` crea un contenedor persistente por agente (keyed por `dev_agents.id`, no por tarea), inyecta la credencial si existe, graba `runtime`/`container_id`/`metadata.machine` y emite `dev.agent.machine` (booting→ready/failed). `run()` ejecuta `claude` dentro de la máquina del agente (machineKey) y reusa su toolchain + `/work` entre tareas del rol.
- [x] **Visible en el UI**: `agent-detail-panel` muestra fila de máquina (imagen + indicador up/apagada + tooling) y el tab Terminal se conecta a la máquina del agente aunque no haya tarea activa, con botón "Levantar máquina ahora" (`POST sessions/:id/agents/:role/machine/boot`). Teardown en cancel (`shutdownSessionMachines`).

### Pendiente (máquinas por agente)
- [ ] **P0 — Habilitar Docker real en `eva-core` Compose**: el contenedor `apps/eva-core/Dockerfile` no instala el CLI `docker`; montar `/var/run/docker.sock` no basta y `dockerAvailable()` cae en `false`. Además, `eva-sandbox-builder` solo construye `eva-sandbox`, no `eva-agent-base/backend/frontend/testing`. Añadir CLI + builder de imágenes de agentes y un smoke desde dentro de `eva-core`.
- [ ] **P0 — Recuperar Docker después del arranque**: `ClaudeCodeRunnerService.dockerAvailable()` cachea `false` para toda la vida del proceso. Si Docker Desktop/daemon aún no estaba listo, ninguna máquina se levantará hasta reiniciar core; usar TTL/retry como `SandboxService`.
- [ ] **Smoke real multi-imagen**: con `./docker/agents/build.sh` corrido, arrancar un goal y verificar que backend/frontend/testing levantan sus imágenes respectivas (no la base) y que el tab Terminal abre cada máquina viva.
- [ ] **Imágenes devops/preview dedicadas**: hoy caen en `eva-agent-base`; crear `eva-agent-devops` (docker·terraform·kubectl·helm) y `eva-agent-preview` (serve·playwright headless) cuando se necesiten.
- [ ] **Lifecycle de recursos**: las máquinas viven toda la sesión; evaluar idle-reap o límite de máquinas concurrentes por org para no saturar el host.

## 0a. Dev Studio — Observabilidad + Claude Code para agentes de código (shipped 2026-06-15)
- [x] **Equipo dinámico**: el architect arma el equipo mínimo por complejidad; el orquestador registra en `dev_agents` solo los roles usados; `AgentFlowDiagram` renderiza topología dinámica (no 7 nodos fijos).
- [x] **Logs reales**: `getAgentLogs` leía columnas inexistentes (`step/type/content`) de `task_events` (que tiene `event_type/payload`) — corregido y remapeado. Comms: `getAgentDetail` filtraba por columna `actor` inexistente en `dev_events` — ahora filtra por los `task_id` del rol.
- [x] **Estado en vivo**: panel del agente muestra `status` real (de `dev_agents`) + último paso; tareas fallidas muestran `result_summary`.
- [x] **Claude Code para roles de código** (backend/frontend/testing): imagen `eva-claude-sandbox` (`docker build -t eva-claude-sandbox docker/claude-sandbox`), `ClaudeCodeRunnerService` corre `claude` headless con el token inyectado por env (nunca en argv). Credencial en `org_integrations` (kind=`credential`, provider=`claude_code`) con `{ method, token }`. Provisioning vía human task `claude_code_auth` + UI `ClaudeCodeAuthPanel` (3 métodos: oauth/api_key/org; foco OAuth).

### Pendiente (Claude Code)
- [x] **Terminal en vivo del contenedor Claude Code**: `ClaudeCodeRunnerService` ahora crea un contenedor nombrado y persistente por tarea (`eva-claude-<taskId>`), corre `claude` vía `docker exec`, y expone `attachShellStream` (PersistentShell sobre `docker exec -i`). El gateway (`app.gateway.ts`) cae al runner si `SandboxService` no tiene sesión — el tab Terminal funciona transparente. Contenedor vive 5 min tras terminar (grace) para inspección.
- [x] **Validar token al guardar** (shipped 2026-06-19): `verifyToken()` corre `claude -p` 1-turn en contenedor efímero y el endpoint rechaza tokens inválidos con 400. Ver §0aa.
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
Sandbox concurrency stress test, network-compliance telemetry, and `terminal_run` network/approval integration shipped (see [sandbox.service.spec.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/__tests__/sandbox.service.spec.ts) and `recordNetworkExec` in [agent-loop.service.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/agent-loop.service.ts) → `task_events` event_type `sandbox.network_exec`).

- [x] **Network support in `terminal_run`**: added `network: boolean` parameter to `terminal_run` to execute commands requiring internet access (e.g., `yt-dlp`), routed through the same allowlist and approval workflows as `code_execute`.
- [x] **Chat approval states & context**: Fixed task state hangs after chat approvals/rejections and ensured that pending questions (`waiting_for_input`) and approvals (`waiting_for_approval`) are fetched and loaded as assistant turns in the conversation history context.
- [x] **P0 — WhatsApp deterministic routing before agent loop**: explicit WhatsApp screenshot/read/setup/send requests now stay in `handleWhatsAppRequest()`; a model refusal or invented browser session can no longer suppress the real integration.
- [x] **P0 — Expose and verify WhatsApp screenshots end-to-end**: screenshot intents bypass the loop, call `captureSessionScreenshot()`, upload the browser PNG, and publish `task.media`; the regression test uses the exact failed production phrase.
- [x] **P0 — Block public research for private-app intents**: WhatsApp is covered by the classic private-data recovery guard, WhatsApp-only phases omit `web_search`/`browser_navigate`, and JSON fallback decisions can only dispatch tools present in the adaptive step subset.
- [x] **P1 — Fix WhatsApp tiering and integration tests**: screenshots/reads are immediate with code/skills/self-improvement disabled; message sends use the approval horizon. Tests prove a successful-but-wrong loop result is never consulted.
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
- [ ] **Live WhatsApp Visual Smoke**: with a logged-in WhatsApp Web profile, request the exact screenshot phrase and “cuáles mensajes tengo sin responder”; verify the screenshot publishes `task.media` without any `agent-loop`/skills/research entries, then verify unanswered classification and approval-gated sending.
- [ ] **Live Smart Browser Smoke**: run `browser_navigate` on WhatsApp/Uber with an intentionally ambiguous or stale selector path; verify task `browser_memory` records failed/working selectors, autocomplete/listbox options are exposed as clickable targets, a visual diagnostic is emitted after no-progress, and `agent_data_log` stores a reusable `browser:site:<host>` learning.
- [ ] **Live Location + Uber Web Smoke**: from Playground and Wear OS, send "dónde estoy", "cotiza Uber de casa al Zócalo", and "pídeme un Uber al trabajo"; verify browser/Wear permission prompts, `request_context.location` on the task, no guessed location fallback, known place `work` resolution, visible Uber quote screenshot/fare extraction or route-form fallback, route-form validation retries when “Dropoff location” remains empty or only matches generic CDMX/city tokens, geometric first-suggestion selection on Uber autocomplete rows without roles, and `uber.ride.order` approval before any real booking.
- [ ] **Live PDF-To-Telegram Smoke**: end-to-end task that researches, generates a PDF in `/work`, sends it through Telegram, confirms `code_execute` + `telegram_send_file` in the task log, verifies malformed/blank PDFs are rejected before upload, and verifies that missing delivery does not transition to `completed`.
- [ ] **Live Pipeline Smoke**: end-to-end "Crea un informe de ventas, conviértelo a PDF y envíalo por Telegram" — confirm 3 phase logs, parallel wave detection, PDF artifact in `/work`, Telegram delivery.
