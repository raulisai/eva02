# EVA · Living Backlog & Improvements

This backlog keeps only relevant, actionable improvements. Completed work moves out (it lives in code + CLAUDE.md, not here). Environment-only checks that need live credentials live in §4. Agents must update this file as they resolve items or discover new tasks.

---

## 1. Runtime Safety & Observability
- [ ] **Sandbox Concurrency Stress Test**: focused stress test for concurrent task containers + multiplexed persistent shells (`session` 0-9), background processes, and the idle reaper releasing workspaces without leaking containers or shell PIDs.
- [ ] **Sandbox Network Compliance Telemetry**: persist/report when the model requested network execution, whether it passed the allowlist, and why it was blocked — so network usage is auditable.

---

## 2. Procedural Skills (Hermes parity)
Skills system already shipped (doc-skills + stable index + `skill_view`/`skill_manage` + post-task `BackgroundReviewService`). Remaining work is gated on the migration below.

- [ ] **Apply migration 034 (blocker)**: `034_skill_docs.sql` (adds `content_md/category/is_pinned/kind` to `skills` + `skill_files` table with RLS) must be applied to Supabase cloud. Until then `skill_view`/`skill_manage` return empty and the whole doc-skill loop is inert.
- [ ] **Surface background-review to the user**: emit a compact summary after the learning loop ("💾 Skill 'deploy-flow' updated"), mirroring Hermes' `summarize_background_review_actions`.
- [ ] **Usage telemetry for doc-skills**: wire `skill_view`/`skill_manage` of `kind='doc'` skills into `skill_usage_stats` so the index demotion can rank by real usage, not just goal keyword overlap (today only `code` skills record outcomes via SkillLibraryService).

---

## 3. Profile Hub Roadmap
Tracked in [profile_hub_plan.md](file:///Users/djoker/code/eva02/docs/profile_hub_plan.md).

- [ ] **Fase 3 — Interaction**: direct edit/create for notes/todos/goals/events, drag reorder, dialogs, masking/reveal audit UI for private vault.
- [ ] **Fase 4 — Auto-fill**: structured digester v2, profile/todo/goal/note tools, suggestion inbox UI, realtime updates.

---

## 4. External Validation Queue
These require live credentials/environment and are not code backlog until available.

- [ ] **RLS Verification**: after applying migrations to Supabase, run `RLS_TEST=true npm run test:e2e` and verify `agent_souls.private_context_ciphertext` and `profile_private_items.ciphertext` are unreadable through the authenticated Data API.
- [ ] **Production Docker Check**: on the target Linux host, verify the Docker socket mount and rebuild the enriched sandbox image (`docker build -t eva-sandbox docker/sandbox` — now bundles `bash` + `util-linux` for the PTY and `ipython` for rich tracebacks). Confirm the persistent shell (state across steps, dialog → `terminal_input`) works there.
- [ ] **Live Telegram Media Smoke**: real Telegram webhook media limits, transcription, image analysis, `yt-dlp`, and document send flows with a live bot. Also test inline approval button taps.
- [ ] **Live PDF-To-Telegram Smoke**: end-to-end task that researches, generates a PDF in `/work`, sends it through Telegram, and confirms `code_execute` + `telegram_send_file` in the task log.
- [ ] **Live Pipeline Smoke**: end-to-end "Crea un informe de ventas, conviértelo a PDF y envíalo por Telegram" — confirm 3 phase logs, parallel wave detection, PDF artifact in `/work`, Telegram delivery.
