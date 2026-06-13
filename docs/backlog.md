# EVA · Living Backlog & Improvements

This backlog keeps only relevant,compiles outstanding tasks, technical debt, actionable improvements. Completed items and environment-only smoke checks should move out of the active list so future work has room to breathe, Agents must update this file as they resolve items or discover new tasks.

---

## 1. Agent Intelligence & Control Plane
- [ ] **Scheduled Autonomy Rows**: Move `AgentIntelligenceService` periodic autonomy tick into explicit `scheduled_jobs` rows so wakeups are visible, pausable, and auditable in the dashboard.
- [ ] **Ask User Resume on Startup**: On core startup, scan unresolved `agent_input_requests` and requeue tasks that are ready or timed out, so conversations survive restarts.
- [x] **Tier Step Controls**: Dashboard controls `max_steps_by_tier`; runner uses org settings for medium/long loop depth with safe clamps.
- [x] **Fluid Approvals UX**: human approval ask (no hash/level/screenshot), `notify` flag to avoid duplicate messages, natural sí/no keywords, evidence-on-demand screenshots, early long-task ack.
- [ ] **Telegram Inline Approval Buttons**: add `reply_markup` inline keyboard (✅/❌) + `callback_query` webhook handling so approvals resolve with one tap instead of a typed reply.
- [ ] **Evidence Follow-up Window**: allow "mándame la captura" AFTER an action executed (currently `send_evidence` must be requested in the original order; post-hoc requests need the session screenshot to be retrievable).
- [x] **Spanish Verb Suffix Routing**: Tier classifier handles attached Spanish pronouns like `descárgamelo`, `mándaselo`, `envíaselo`, `recuérdamelo`.

---

## 2. Runtime Safety & Observability
- [ ] **Sandbox Concurrency Stress Test**: Add a focused stress test for concurrent sandbox sessions releasing workspaces and background processes.
- [ ] **Sandbox Network Compliance Telemetry**: Persist/report when the model requested network execution, whether it passed allowlist checks, and why it was blocked.
- [ ] **CI Freshness Gate**: Add `npm run docs:check` to CI so migrations/controllers cannot drift from the project map.

---

## 3. Integrations With Real Product Impact
- [ ] **Large Media Compression**: Add ffmpeg compression fallback for outbound videos/files over Telegram platform limits.
- [ ] **MCP Stdio Secret Injection**: Wire dashboard MCP presets to runner-side env/secret injection for stdio tools that need API tokens or database URLs.
- [ ] **MCP OAuth Preflight**: Add a connection preflight for remote MCP nodes that require OAuth before exposing them as usable tools.

---

## 4. Profile Hub Roadmap
Tracked in [profile_hub_plan.md](file:///Users/djoker/code/eva02/docs/profile_hub_plan.md).

- [x] **Fase 1 — Datos+API Base**: migration 033 for structured profile todos/notes/goals + encrypted vault, sensitivity classifier, profile facts service/controller, focused unit tests.
- [x] **Fase 2 — Split UI Base**: dedicated `/profile` route, `/soul` focused on agent identity, sidebar entry.
- [ ] **Profile Hub RLS Verification**: after applying migration 033 to Supabase, run `RLS_TEST=true npm run test:e2e` and verify `profile_private_items.ciphertext` is not readable by authenticated Data API.
- [ ] **Fase 3 — Interaction**: direct edit/create for notes/todos/goals/events, drag reorder, dialogs, masking/reveal audit UI for private vault.
- [ ] **Fase 4 — Auto-fill**: structured digester v2, profile/todo/goal/note tools, suggestion inbox UI, realtime updates.
- [ ] **Fase 5 — Prompt**: shared `ProfileContextBuilder` and deprecate free-text `cowork_context`.

---

## 5. Multi-Phase Pipeline

- [x] **PipelineRunnerService**: detects multi-phase goals (pronoun back-references, connector chains, artifact → format → delivery), synthesizes phases via LLM, runs each phase as a separate AgentLoop with shared sandbox workspace so files written in Phase N are readable in Phase N+1.  
  Files: `src/agent/pipeline-runner.types.ts`, `src/agent/pipeline-runner.service.ts`.  
  Route: `multi-phase-pipeline` at priority 43 in AgentRunnerService.
- [ ] **Parallel Phases**: execute independent phases (empty `dependsOn`) concurrently using `Promise.all` — currently sequential.
- [ ] **Phase Retry**: allow individual phase retry without rerunning the full pipeline (resume from last failed phase).
- [ ] **Pipeline Progress in UI**: display per-phase status chips in the frontend task detail view using `task.metadata.pipeline`.
- [ ] **Live Pipeline Smoke**: End-to-end test: "Crea un informe de ventas, conviértelo a PDF y envíalo por Telegram" — confirm 3 phase logs, PDF artifact in `/work`, Telegram delivery.

---

## 6. External Validation Queue
These are important, but not code backlog until the real environment/credentials are available.

- [ ] **RLS Verification**: After applying migrations 027-032 to Supabase, run `RLS_TEST=true npm run test:e2e` and verify `agent_souls.private_context_ciphertext` is unreadable through authenticated Data API.
- [ ] **Production Docker Check**: Verify Docker socket mount and `eva-sandbox-builder` image pull on the target Linux host.
- [ ] **Live Telegram Media Smoke**: Test real Telegram webhook media limits, transcription, image analysis, `yt-dlp`, and document send flows with a live bot.
- [ ] **Live PDF-To-Telegram Smoke**: Run an end-to-end task that researches, generates a PDF in `/work`, and sends it through Telegram, confirming the task log shows both `code_execute` and `telegram_send_file` before completion.
