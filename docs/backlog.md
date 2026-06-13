# EVA · Living Backlog & Improvements

This backlog keeps only relevant, actionable improvements. Completed items move out; environment-only smoke checks live in §6. Agents must update this file as they resolve items or discover new tasks.

---

## 1. Runtime Safety & Observability
- [ ] **Sandbox Concurrency Stress Test**: Add a focused stress test for concurrent sandbox sessions releasing workspaces and background processes.
- [ ] **Sandbox Network Compliance Telemetry**: Persist/report when the model requested network execution, whether it passed allowlist checks, and why it was blocked.

---

## 1a. Code Execution (Agent Zero parity)
El sandbox foreground corre en un **shell persistente con PTY** ([sandbox-shell.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/sandbox-shell.ts) + `execInSession` en [sandbox.service.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/sandbox.service.ts)): estado de shell vivo entre pasos (env/cd/venv/procesos), timeouts multi-fase (`completed/running/awaiting_input`), detección de diálogo + tool `terminal_input`, terminales multiplexadas (`session` 0-9), limpieza ANSI/marker. Espejo de `plugins/_code_execution` de Agent Zero.

Pendientes del análisis (Tier 2-3, no implementados aún):
- [ ] **IPython para python**: correr `ipython` en la imagen enriquecida en vez de `python file.py` → tracebacks ricos, menos reintentos del modelo.
- [ ] **DirtyJson en `parseDecision`** ([agent-loop.service.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/agent-loop.service.ts)): reparar JSON malformado (llaves sin cerrar, comas colgantes, comillas simples) antes de devolver null.
- [ ] **Smoke real del PTY**: extender `scripts/sandbox-smoke.ts` para validar estado persistente (`export X=1` → leerlo en el paso siguiente) y un diálogo `[y/n]` → `terminal_input` contra Docker real.
- [ ] **Time Travel**: snapshots de `/work` con revert en fronteras de fase.

---

## 1b. Procedural Skills (Hermes parity)
Sistema de skills como memoria procedimental: `skills.content_md` + tabla `skill_files`, índice estable obligatorio en cada system prompt, `skill_view`/`skill_manage`, y `BackgroundReviewService` (learning loop post-tarea). Detalle en [skill-docs.service.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/skill-docs.service.ts) y [background-review.service.ts](file:///Users/djoker/code/eva02/apps/eva-core/src/agent/background-review.service.ts).

Hecho: índice con demotion "solo nombres" para categorías fuera del goal; `viewSkill` surfacea vecinos del grafo (`skill_graph_edges`) + sustituye template vars (`${EVA_SKILL_DIR}`/`${EVA_TASK_ID}`); inline-shell `` !`cmd` `` expandido vía sandbox en el handler `skill_view`; background-review como mini-loop que puede `view` una skill antes de parchearla.

- [ ] **Aplicar migración 034**: `034_skill_docs.sql` (añade `content_md/category/is_pinned/kind` a `skills` + tabla `skill_files` con RLS) requiere aplicarse en Supabase cloud. Hasta entonces `skill_view`/`skill_manage` devuelven vacío.
- [ ] **Telemetría de uso para doc-skills**: conectar `skill_view`/`skill_manage` de skills `kind='doc'` a `skill_usage_stats` (hoy solo las `code` registran outcomes vía SkillLibraryService).
- [ ] **Surface del background-review al usuario**: emitir un resumen compacto ("💾 Skill 'deploy-flow' actualizada") tras el learning loop, como hace Hermes (`summarize_background_review_actions`).
- [ ] **Curator de consolidación**: job de autonomía que archive skills stale y consolide solapadas (el review ya puede señalar overlaps; falta el actor a escala).

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
