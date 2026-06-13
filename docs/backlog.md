# EVA · Living Backlog & Improvements

This backlog keeps only relevant, actionable improvements. Completed work moves out (it lives in code + CLAUDE.md, not here). Environment-only checks that need live credentials live in §4. Agents must update this file as they resolve items or discover new tasks.

---

## 1. Runtime Safety & Observability
Sandbox concurrency stress test and network-compliance telemetry shipped (see [sandbox.service.spec.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/__tests__/sandbox.service.spec.ts) and `recordNetworkExec` in [agent-loop.service.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/agent-loop.service.ts) → `task_events` event_type `sandbox.network_exec`).

- [ ] **Task Horizon UI**: surface `task.metadata.task_horizon` in the dashboard task detail so operators can see why EVA chose immediate/background/scheduled/standby/approval handling.
- [x] **Budget policy (model range per case)**: centralized in [budget-policy.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/budget-policy.ts) (pure, unit-tested). Long/medium/deliverable tasks open at `balanced` (`initialBudget`), failures climb the full ladder cheap→balanced→powerful (`escalateOnEvent`; hard reasons DoD/security/persistent-stall jump to powerful), clean tails de-escalate (`deescalateOnSuccess`, mechanical/delivery count double), and synthesis steps are floored at `balanced` (`applyPhaseFloor`). Tier flows from `runAgentLoop` → `AgentLoopOptions.tier`. Follow-up: surface `modelBudgetPerStep` trail in the task detail UI.
- [x] **Proactive memory injection**: `MemoryRecallService.proactiveContext()` uses one `embed()` call (no LLM) to search memories with threshold 0.62/importance ≥ 0.35, returns ≤3 compact bullets. Wired in `agent-loop.service.ts` for `depth=0` + `long`/`medium`/deliverable tasks. Never blocks startup (`.catch(() => null)`). `MemoryAgentService.searchByEmbedding()` and `MemoryService.searchByEmbedding()` added to accept pre-computed embeddings without double-embedding. Follow-up: surface `modelBudgetPerStep` trail in task detail UI.

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
- [ ] **Live PDF-To-Telegram Smoke**: end-to-end task that researches, generates a PDF in `/work`, sends it through Telegram, confirms `code_execute` + `telegram_send_file` in the task log, verifies malformed/blank PDFs are rejected before upload, and verifies that missing delivery does not transition to `completed`.
- [ ] **Live Pipeline Smoke**: end-to-end "Crea un informe de ventas, conviértelo a PDF y envíalo por Telegram" — confirm 3 phase logs, parallel wave detection, PDF artifact in `/work`, Telegram delivery.
