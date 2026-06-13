# EVA · Living Backlog & Improvements

This backlog keeps only relevant, actionable improvements. Completed items move out; environment-only smoke checks live in §6. Agents must update this file as they resolve items or discover new tasks.

---

## 1. Runtime Safety & Observability
- [ ] **Sandbox Concurrency Stress Test**: Add a focused stress test for concurrent sandbox sessions releasing workspaces and background processes.
- [ ] **Sandbox Network Compliance Telemetry**: Persist/report when the model requested network execution, whether it passed allowlist checks, and why it was blocked.

---

## 2. Profile Hub Roadmap
Tracked in [profile_hub_plan.md](file:///Users/djoker/code/eva02/docs/profile_hub_plan.md).

- [ ] **Fase 3 — Interaction**: direct edit/create for notes/todos/goals/events, drag reorder, dialogs, masking/reveal audit UI for private vault.
- [ ] **Fase 4 — Auto-fill**: structured digester v2, profile/todo/goal/note tools, suggestion inbox UI, realtime updates.

---

## 3. External Validation Queue
These require live credentials/environment and are not code backlog until available.

- [ ] **RLS Verification**: After applying migrations 027-033 to Supabase, run `RLS_TEST=true npm run test:e2e` and verify `agent_souls.private_context_ciphertext` and `profile_private_items.ciphertext` are unreadable through authenticated Data API.
- [ ] **Production Docker Check**: Verify Docker socket mount and `eva-sandbox-builder` image pull on the target Linux host.
- [ ] **Live Telegram Media Smoke**: Test real Telegram webhook media limits, transcription, image analysis, `yt-dlp`, and document send flows with a live bot. Also test inline approval button taps.
- [ ] **Live PDF-To-Telegram Smoke**: End-to-end task that researches, generates a PDF in `/work`, sends it through Telegram, and confirms `code_execute` + `telegram_send_file` in task log.
- [ ] **Live Pipeline Smoke**: End-to-end: "Crea un informe de ventas, conviértelo a PDF y envíalo por Telegram" — confirm 3 phase logs, parallel wave detection, PDF artifact in `/work`, Telegram delivery.
