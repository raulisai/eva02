# EVA Seed Change Log

Newest first. Every use of `$eva-project-seed` must add one `C:` and one `P:` entry. Keep it compact and exact.

### 2026-06-24 08:53Z
C: dev-studio/claude-oauth: accept machine-local Claude Code login verified by `claude auth status --json` when the CLI does not expose an exportable token; allow orchestrator guards and runs to use the authenticated persistent machine; remove credential-content logging; files=apps/eva-core/src/dev-studio/claude-code-runner.service.ts,apps/eva-core/src/dev-studio/dev-orchestrator.service.ts,apps/eva-core/src/dev-studio/dev-studio.controller.ts,apps/eva-core/src/dev-studio/__tests__/dev-robustness.spec.ts,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=npm test --workspace @eva/core -- src/dev-studio/__tests__/dev-robustness.spec.ts --runInBand (12 passed); npm run build --workspace @eva/core
P: pending/improve -> run one real queued code-agent task after the live machine-local OAuth login and confirm Claude Code executes without reopening provisioning

### 2026-06-24 07:47Z
C: dev-studio/claude-oauth: make automated Claude Code auth URL capture tolerate wrapped terminal output, OSC hyperlinks, and query-fragment output; pass no-color/wide-terminal env into `docker exec`; avoid blank-code Enter at the prompt and accept duplicate/tardy code submits when already in flight/configured; files=apps/eva-core/src/dev-studio/claude-code-runner.service.ts,apps/eva-core/src/dev-studio/dev-studio.controller.ts,apps/eva-core/src/dev-studio/__tests__/dev-robustness.spec.ts,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=npm test --workspace @eva/core -- src/dev-studio/__tests__/dev-robustness.spec.ts --runInBand; npm run build --workspace @eva/core
P: pending/improve -> run a live Dev Studio agent-machine OAuth smoke with real Claude Code and confirm the automatic flow reaches code entry, accepts the pasted code once, and does not fall back to the terminal

### 2026-06-21 08:17Z
C: whatsapp/runtime: route explicit WhatsApp screenshots/reads/sends deterministically, classify screenshots as immediate and sends as approval, block WhatsApp public-research fallback, and enforce adaptive tool subsets for JSON decisions; files=apps/eva-core/src/agent/tier.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts,apps/eva-core/src/agent/__tests__/agent-loop.service.spec.ts,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- --runInBand src/agent/__tests__/agent-runner.service.spec.ts src/agent/__tests__/agent-loop.service.spec.ts src/integrations/__tests__/whatsapp-web.service.spec.ts (177 passed); npm run build; npm run lint
P: pending/improve -> run the live WhatsApp screenshot/read/send smoke with the persistent local profile and confirm the action log contains no agent-loop, skills, browser_navigate, or web_search entries

### 2026-06-21 08:05Z
C: diagnosis/whatsapp: traced screenshot refusal to generic-loop precedence, missing screenshot tool/delivery proof, absent logged-in screenshot on unread/unanswered reads, over-broad long-tier routing, and public-research exposure; files=docs/backlog.md,.agents/skills/eva-project-seed/references/change-log.md; tests=cd apps/eva-core && npm test -- --runInBand src/agent/__tests__/agent-runner.service.spec.ts -t "sends a WhatsApp Web screenshot|misspelled screenshot|false WhatsApp capability"
P: pending/improve -> implement deterministic WhatsApp routing before the loop and add an integration test where a successful-but-wrong loop answer cannot suppress screenshot/media delivery

### 2026-06-21 08:05Z
C: agent/tools: restrict browser_navigate in WhatsApp/Services tasks unless explicitly requested; files=apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/__tests__/agent-loop.service.spec.ts; tests=npm test
P: pending/improve -> Implement visual verification rules in AgentLoopService to handle dynamic element loading without full browser_navigate loops.

### 2026-06-21 08:00Z
C: database/approvals: fix memory embeddings schema drift and gracefully handle expired approvals in chat confirmations; files=supabase/migrations/040_add_memory_embeddings_model.sql,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts; tests=npm test
P: pending/improve -> Ensure the PostgREST cache reload is fully propagated under high load or multi-node container environments.

### 2026-06-21 07:48Z
C: agent/context: fix task state machine hangs in chat approvals and ensure conversation history includes pending question context; files=apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts; tests=npm test
P: pending/improve -> Monitor user reply intents that are complex corrections to verify LLM transitions pending approvals correctly.

### 2026-06-21 07:12Z
C: agent/terminal_run: add network parameter support to run terminal commands with internet access; files=apps/eva-core/src/agent/tool-catalog.ts,apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/__tests__/agent-loop.service.spec.ts; tests=npm test
P: pending/improve -> Ensure terminal_run with network behaves correctly under docker-level network latency or packet drop conditions.

### 2026-06-21 07:05Z
C: events: safe Redis disconnect onModuleDestroy; files=apps/eva-core/src/events/event-bus.service.ts; tests=npm test
P: pending/improve -> ensure other modules that use lazy connections clean up without throwing unhandled rejections

### 2026-06-20 02:22Z
C: dashboard: horizontal agent layout, arrow connections on borders, active edge particle animations, card pulse rect animations; files=apps/eva-dashboard/components/dev-studio/agent-flow-diagram.tsx; tests=npm run build -w apps/eva-dashboard && npm run lint -w apps/eva-dashboard
P: pending/improve -> add canvas zoom/pan support for very large agent teams in Dev Studio

### 2026-06-19 22:11Z
C: dev-studio diagnosis: documented Docker runtime/image provisioning gap, sticky negative Docker cache, queued-wave finalization bug, heartbeat tick spam, and missing org scoping; files=docs/backlog.md; tests=cd apps/eva-core && npm test -- --runInBand src/dev-studio/__tests__/agent-machines.spec.ts src/dev-studio/__tests__/claude-code-runner.image.spec.ts src/dev-studio/__tests__/dev-robustness.spec.ts
P: pending/improve -> implement and integration-test the Dev Studio Docker/queued-wave recovery fixes before retrying the Snake session

### 2026-06-16 04:22Z
C: dev-studio: allow session transition from awaiting_goals_approval to running in backend types; files=apps/eva-core/src/dev-studio/dev-studio.types.ts; tests=npm run build -w apps/eva-core && npm run lint -w apps/eva-core
P: pending/improve -> verify RLS policies for organizations and users tables under high concurrency

### 2026-06-16 04:15Z
C: dashboard: revamp Dev Studio session detail UI to Liquid Glass style; files=apps/eva-dashboard/components/dev-studio/agent-flow-diagram.tsx,apps/eva-dashboard/components/dev-studio/session-detail.tsx,apps/eva-dashboard/app/(dashboard)/dev-studio/page.tsx; tests=npm run build -w apps/eva-dashboard && npm run lint -w apps/eva-dashboard
P: pending/improve -> implement visual transitions and animations for the bottom panel view switcher

### 2026-06-15 07:06Z
C: uber-web: route form validation now requires distinctive pickup/dropoff tokens so generic city/CDMX-only destination text does not count as filled; files=apps/eva-core/src/integrations/uber-web.service.ts,apps/eva-core/src/integrations/__tests__/uber-web.service.spec.ts,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=npm test --workspace @eva/core -- src/integrations/__tests__/uber-web.service.spec.ts --runInBand; npm run build --workspace @eva/core; eslint changed uber files; npm run docs:check; git diff --check
P: pending/improve -> run live Uber Web quote smoke for work/LA COCINA DE LUPITA and verify city-only dropoff is rejected, first relevant suggestion is selected, and prices appear

### 2026-06-15 06:55Z
C: browser/uber: SmartNavigator now indexes autocomplete/listbox options and accepts press/scroll/back actions from model JSON; Uber autocomplete selection can click visible plain div suggestion rows near the focused address field when accessible roles are absent; files=apps/eva-core/src/browser/smart-navigator.service.ts,apps/eva-core/src/browser/__tests__/smart-navigator.service.spec.ts,apps/eva-core/src/integrations/uber-web.service.ts,apps/eva-core/src/integrations/__tests__/uber-web.service.spec.ts,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=npm test --workspace @eva/core -- src/browser/__tests__/smart-navigator.service.spec.ts --runInBand; npm test --workspace @eva/core -- src/integrations/__tests__/uber-web.service.spec.ts --runInBand; npm run build --workspace @eva/core; eslint changed browser/uber files; npm run docs:check
P: pending/improve -> run a live Uber Web quote smoke on the captured state and verify selecting "Avenida Norte 209" advances to the destination field and then to visible prices

### 2026-06-15 06:40Z
C: docs/seed: cleaned up deleted project_sections.md references across documentation and seed; files=docs/improvement_loop.md,.agents/skills/eva-project-seed/references/project-map.md; tests=node scripts/check-project-map-freshness.mjs
P: pending/improve -> keep documentation and project-map.md updated with any new migration or core controller route added

### 2026-06-15 06:37Z
C: uber-web: verify pickup/dropoff route form before Search and retry destination autocomplete when Dropoff location remains empty; files=apps/eva-core/src/integrations/uber-web.service.ts,apps/eva-core/src/integrations/__tests__/uber-web.service.spec.ts,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=npm test --workspace @eva/core -- src/integrations/__tests__/uber-web.service.spec.ts --runInBand; npm test --workspace @eva/core -- src/browser/__tests__/browser.service.spec.ts src/integrations/__tests__/uber-web.service.spec.ts src/agent/__tests__/agent-runner.service.spec.ts --runInBand; npm run build --workspace @eva/core; eslint changed uber files
P: pending/improve -> run live Uber quote smoke for "un uber a mi trabajo dame el costo" and verify both autocomplete fields are accepted before Search

### 2026-06-15 05:44Z
C: browser-agent: upgraded SmartNavigator with task memory, enriched visual snapshots, failure diagnosis, progress verification, and per-site learning; files=apps/eva-core/src/browser/smart-navigator.service.ts,apps/eva-core/src/browser/__tests__/smart-navigator.service.spec.ts,apps/eva-core/src/agent/tool-catalog.ts,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=npm test --workspace @eva/core -- src/browser/__tests__/smart-navigator.service.spec.ts --runInBand; npm test --workspace @eva/core -- src/agent/__tests__/agent-loop.service.spec.ts --runInBand; npm run build --workspace @eva/core; eslint changed core files
P: pending/improve -> run live Smart Browser smoke on WhatsApp/Uber to verify browser_memory and browser:site learnings against real UI changes

### 2026-06-15 05:34Z
C: analysis/browser: assessed SmartNavigator gaps vs Comet-style session memory, visual fallback, error diagnosis, and self-improving selectors; files=apps/eva-core/src/browser/smart-navigator.service.ts,apps/eva-core/src/agent/tool-catalog.ts,apps/eva-core/src/agent/agent-loop.service.ts; tests=n/a analysis only
P: pending/improve -> implement browser navigation memory/checkpoints and visual-diagnosis fallback after failed actions or empty DOM

### 2026-06-15 05:19Z
C: agent/browser: exposed SmartNavigator as browser_navigate, added WhatsApp visual unanswered analysis, and blocked generic private-app capability refusals; files=apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/tool-catalog.ts,apps/eva-core/src/agent/__tests__/agent-loop.service.spec.ts,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=npm test --workspace @eva/core -- src/agent/__tests__/agent-loop.service.spec.ts --runInBand; npm test --workspace @eva/core -- src/browser/__tests__/smart-navigator.service.spec.ts --runInBand; npm run build --workspace @eva/core
P: pending/improve -> run a live WhatsApp Web visual smoke with a logged-in profile to verify unread color/badge and last-message-direction inference on real UI

### 2026-06-14 17:44Z
C: location/profile: expanded current-location routing for "sabes cual mi ubicacion" so fresh browser/Wear coordinates answer directly, and added editable Profile Hub known-place addresses via org-scoped PATCH; files=apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts,apps/eva-core/src/agent/dto/profile.dto.ts,apps/eva-core/src/agent/profile.controller.ts,apps/eva-core/src/agent/profile-facts.service.ts,apps/eva-core/src/agent/__tests__/profile-facts.service.spec.ts,apps/eva-dashboard/components/profile/profile-hub-client.tsx,apps/eva-dashboard/__tests__/profile-hub.test.tsx; tests=cd apps/eva-core && npm test -- src/agent/__tests__/agent-runner.service.spec.ts src/agent/__tests__/profile-facts.service.spec.ts --runInBand; cd apps/eva-dashboard && npm test -- --runInBand __tests__/profile-hub.test.tsx; cd apps/eva-core && npm run build; cd apps/eva-dashboard && npm run build; cd apps/eva-core && ../../node_modules/.bin/eslint "{src,test}/**/*.ts"; cd apps/eva-dashboard && npm run lint; npm run docs:check
P: pending/improve -> add route-miss telemetry for personal location questions and a live Profile Hub smoke with real known_places rows before relying on edited addresses for ride actions

### 2026-06-14 05:35Z
C: uber-web: prioritized live Uber Web pickup/dropoff ids and See prices link selector from provided DOM; files=apps/eva-core/src/integrations/uber-web.service.ts,apps/eva-core/src/integrations/__tests__/uber-web.service.spec.ts; tests=npm test --workspace @eva/core -- src/integrations/__tests__/uber-web.service.spec.ts --runInBand; npm test --workspace @eva/core -- src/browser/__tests__/browser.service.spec.ts src/integrations/__tests__/uber-web.service.spec.ts src/agent/__tests__/agent-runner.service.spec.ts --runInBand; npm run build --workspace @eva/core; npx eslint core changed files
P: pending/improve -> run live Uber Web quote against the provided DOM with a logged-in profile and verify suggestions/See prices navigation without requesting a ride

### 2026-06-14 05:33Z
C: uber-web: deterministic quote path, visible fare extraction, route form fallback, and browser Enter key primitive; files=apps/eva-core/src/integrations/uber-web.service.ts,apps/eva-core/src/integrations/__tests__/uber-web.service.spec.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts,apps/eva-core/src/browser/browser.service.ts,apps/eva-core/src/browser/__tests__/browser.service.spec.ts,packages/browser-runtime/src/index.ts,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=npm run build --workspace @eva/browser-runtime; npm test --workspace @eva/core -- src/browser/__tests__/browser.service.spec.ts src/integrations/__tests__/uber-web.service.spec.ts src/agent/__tests__/agent-runner.service.spec.ts --runInBand; npm run build --workspace @eva/core; npx eslint core changed files
P: pending/improve -> run live Uber Web quote smoke with a logged-in local profile and confirm screenshot/fare extraction without requesting a ride

### 2026-06-14 00:22Z
C: location-context: added browser/Wear request location metadata, current-location answers, and Uber approval preparation from fresh origin + known work destination; files=apps/eva-core/src/common/request-context.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/wear-fast-path/wear-fast-path.service.ts,apps/eva-core/src/wear-fast-path/core-fallback.manager.ts,apps/eva-dashboard/components/playground/playground-client.tsx,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts,apps/eva-core/src/wear-fast-path/__tests__/wear-fast-path.service.spec.ts,apps/eva-core/src/wear-fast-path/__tests__/core-fallback.manager.spec.ts,apps/eva-dashboard/__tests__/playground.test.tsx,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- src/agent/__tests__/agent-runner.service.spec.ts src/wear-fast-path/__tests__/wear-fast-path.service.spec.ts src/wear-fast-path/__tests__/core-fallback.manager.spec.ts --runInBand; cd apps/eva-dashboard && npm test -- --runInBand __tests__/playground.test.tsx; cd apps/eva-core && npm run build; cd apps/eva-dashboard && npm run build; cd apps/eva-dashboard && npm test -- --runInBand; npm run docs:check; cd apps/eva-core && npm test -- --runInBand (633/634, unrelated sandbox Docker/session failure)
P: pending/improve -> run live Playground + Wear OS location smoke and verify Uber approval with a real account without confirming a ride

### 2026-06-13 21:06Z
C: agent/communication: improved inbound/outbound Telegram media handling with native format routing and automatic sandbox media downloading; files=apps/eva-core/src/communication/telegram.adapter.ts,apps/eva-core/src/communication/communication.service.ts,apps/eva-core/src/agent/sandbox.service.ts,apps/eva-core/src/communication/__tests__/telegram.adapter.spec.ts,apps/eva-core/src/agent/__tests__/sandbox.service.spec.ts,apps/eva-core/src/communication/__tests__/communication.service.spec.ts; tests=cd apps/eva-core && npm test
P: pending/improve -> verify that the downloaded files are correctly accessible to Python and bash tools in a live sandbox environment

### 2026-06-13 19:01Z
C: dashboard/skills: moved skill delete button to the left side next to status badge; files=apps/eva-dashboard/components/skills/skill-list.tsx; tests=npm run build
P: pending/improve -> surface delete confirmation inline to avoid browser native confirm alert

### 2026-06-13 18:25Z
C: agent-loop: added runtime intelligence guardrails for report/delivery tasks: hard web_search budget after 2 successful searches, outgoing PDF quality validation before Telegram upload, and regression tests for blank/malformed PDFs and search-loop prevention; files=apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/__tests__/agent-loop.service.spec.ts,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- src/agent/__tests__/agent-loop.service.spec.ts --runInBand; cd apps/eva-core && npm run build; npm run docs:check
P: pending/improve -> add a real renderer-backed PDF screenshot/OCR smoke in the sandbox image so visual blank-page detection can graduate from structural heuristics to rendered-page validation

### 2026-06-13 18:16Z
C: agent-loop: fixed explicit deliverable exhaustion so PDF/Telegram tasks enter final delivery mode, avoid dependency installs for PDFs, and return ok=false when required delivery is still pending instead of completing the task; files=apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/__tests__/agent-loop.service.spec.ts,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- src/agent/__tests__/agent-loop.service.spec.ts --runInBand; cd apps/eva-core && npm run build; npm run docs:check
P: pending/improve -> run the live PDF-to-Telegram smoke with real Telegram credentials and verify pending delivery remains non-completed in the dashboard/task log

### 2026-06-13 18:07Z
C: agent/tasks: added task horizon decision for background/scheduled/standby/approval routing, long ask_user timeouts, waiting_for_input for forms/setup, root prompt self-improvement policy, and formal task.step events; files=apps/eva-core/src/agent/tier.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/agent-intelligence.service.ts,apps/eva-core/src/events/event-bus.service.ts,apps/eva-core/src/gateway/events-bridge.service.ts,apps/eva-core/src/tasks/dto/transition-task.dto.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts,apps/eva-core/src/agent/__tests__/agent-loop.service.spec.ts,apps/eva-core/src/agent/__tests__/agent-intelligence.service.spec.ts,apps/eva-core/src/tasks/tasks.service.spec.ts,docs/architecture.md,docs/process_flows.md,docs/project_sections.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- --runInBand; cd apps/eva-core && npm run build; npm run docs:check
P: pending/improve -> surface task.metadata.task_horizon in dashboard task detail and consider per-org configurable standby timeout defaults

### 2026-06-13 17:55Z
C: agent/communication: implemented dynamic notification routing by task source and expanded long task step budgets; files=apps/eva-core/src/communication/communication.service.ts,apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/agent-intelligence.service.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/agent-loop.service.spec.ts,apps/eva-core/src/agent/__tests__/agent-intelligence.service.spec.ts; tests=npm test in apps/eva-core, npm run build
P: pending/improve -> evaluate the dynamic notification routing on a real WearOS device and check RLS policies

### 2026-06-13 17:32Z
C: agent/loop: revised yt-dlp instruction to encourage search query capability and bypass web_search link lookup loops; files=apps/eva-core/src/agent/agent-loop.service.ts; tests=cd apps/eva-core && npm test -- src/agent/__tests__/agent-loop.service.spec.ts --runInBand && npm run build && npm run docs:check
P: pending/improve -> monitor agent loop execution success rate for YouTube media requests to ensure direct downloading works

### 2026-06-13 17:27Z
C: agent/loop: enhanced agency by removing obsolete sandbox read-only rules, making write-tool rules generic, and preventing search loops; files=apps/eva-core/src/agent/agent-loop.service.ts,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- src/agent/__tests__/agent-loop.service.spec.ts --runInBand && npm run build && npm run docs:check
P: pending/improve -> evaluate loop performance on real tasks with writing actions and track success rate of the new prompt rules

### 2026-06-13 13:20Z
C: agent/pipeline: pipeline retry now reuses `task.metadata.pipeline.definition` plus completed phase outputs and reruns only failed/skipped phases when the same task is reset to pending; files=apps/eva-core/src/agent/pipeline-runner.types.ts,apps/eva-core/src/agent/pipeline-runner.service.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/pipeline-runner.service.spec.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts,docs/architecture.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- src/agent/__tests__/pipeline-runner.service.spec.ts src/agent/__tests__/agent-runner.service.spec.ts --runInBand; cd apps/eva-core && npm run build; npm run docs:check
P: pending/improve -> add dashboard affordance/text that labels retry as "retry failed phases" when `metadata.pipeline.retryable` is true, so users understand completed phases will be reused.

### 2026-06-13 13:01Z
C: agent/profile/jobs: extracted `ProfileContextBuilderService` for structured Profile Hub prompt context and moved AgentIntelligence autonomy wakeups into visible `scheduled_jobs` rows routed internally by `AgentRunnerService`; files=apps/eva-core/src/agent/profile-context-builder.service.ts,apps/eva-core/src/agent/__tests__/profile-context-builder.service.spec.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/agent-intelligence.service.ts,apps/eva-core/src/jobs/scheduled-jobs.service.ts,apps/eva-core/src/jobs/job-scheduler.service.ts,docs/backlog.md,docs/profile_hub_plan.md,docs/architecture.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- src/agent/__tests__/profile-context-builder.service.spec.ts src/agent/__tests__/agent-runner.service.spec.ts src/agent/__tests__/agent-intelligence.service.spec.ts src/jobs/__tests__/scheduled-jobs.service.spec.ts src/jobs/__tests__/job-scheduler.service.spec.ts --runInBand; cd apps/eva-core && npm run build; npm run docs:check
P: pending/improve -> MCP Stdio Secret Injection remains the next integrations backlog item; newly created orgs after process bootstrap may need an explicit `ensureAgentAutonomyJobs` hook if no restart occurs.

### 2026-06-13 12:49Z
C: integrations: Telegram outbound native videos over 50 MB now attempt ffmpeg compression before send; MCP HTTP/SSE test preflights OAuth-required remotes and hides tools until auth is connected; files=apps/eva-core/src/communication/telegram.adapter.ts,apps/eva-core/src/communication/__tests__/telegram.adapter.spec.ts,apps/eva-core/src/integrations/integrations.service.ts,apps/eva-core/src/integrations/__tests__/integrations.service.spec.ts,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- src/communication/__tests__/telegram.adapter.spec.ts --runInBand; cd apps/eva-core && npm test -- src/integrations/__tests__/integrations.service.spec.ts --runInBand; cd apps/eva-core && npm run build
P: pending/improve -> MCP Stdio Secret Injection still needs runner-side env/secret mapping for stdio process launches.

### 2026-06-13 12:42Z
C: dashboard/tasks: task detail renders task.metadata.pipeline phase chips; backlog removed completed pipeline UI and duplicate Profile Hub RLS item; files=apps/eva-dashboard/components/tasks/task-detail.tsx,apps/eva-dashboard/__tests__/tasks.test.tsx,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-dashboard && npm test -- --runInBand __tests__/tasks.test.tsx; cd apps/eva-dashboard && npm run build; npm run docs:check
P: pending/improve -> Phase Retry remains: resume only failed/skipped pipeline phases without rerunning completed phases.

### 2026-06-13 01:33Z
C: agent,communication: parallel pipeline waves + startup input resume + Telegram inline approval buttons; files=apps/eva-core/src/agent/pipeline-runner.service.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/communication/telegram.adapter.ts,apps/eva-core/src/communication/communication.service.ts,apps/eva-core/src/communication/communication.types.ts,docs/backlog.md; tests=npm test (524 passed)
P: pending/improve -> Phase Retry, Pipeline Progress in UI, Evidence Follow-up Window, Large Media Compression

### 2026-06-13 01:00Z
C: approvals-ux: human approval messages (no hash/screenshot), notify flag to dedupe channel notifications, broader si/no keywords, evidence-on-demand screenshots via agent/evidence.ts, long-task ack before context load; files=apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/evidence.ts,apps/eva-core/src/approvals/approvals.service.ts,apps/eva-core/src/approvals/dto/request-approval.dto.ts,apps/eva-core/src/communication/communication.service.ts,docs/process_flows.md,docs/backlog.md; tests=npm test (510 passed)
P: pending/improve -> Telegram inline approval buttons (callback_query); evidence follow-up after execution

### 2026-06-13 00:11Z
C: profile-hub: fixed suggestion accept flow so accepted low-confidence facts apply instead of re-entering inbox; files=apps/eva-core/src/agent/profile-facts.service.ts; tests=cd apps/eva-core && npm test -- src/agent/__tests__/profile-facts.service.spec.ts --runInBand; cd apps/eva-core && npm run build
P: pending/improve -> add integration/e2e coverage for profile suggestion accept/dismiss once migration 033 is applied

### 2026-06-13 00:10Z
C: profile-hub: implemented structured user profile hub with migration 033, secure profile API, /profile dashboard, and /soul agent-only split; files=supabase/migrations/033_profile_hub.sql,apps/eva-core/src/agent/profile.controller.ts,apps/eva-core/src/agent/profile-facts.service.ts,apps/eva-core/src/agent/sensitivity-classifier.service.ts,apps/eva-dashboard/app/(dashboard)/profile/page.tsx,apps/eva-dashboard/components/profile/profile-hub-client.tsx,apps/eva-dashboard/components/soul/soul-editor.tsx,docs/backlog.md,docs/profile_hub_plan.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- src/agent/__tests__/sensitivity-classifier.service.spec.ts src/agent/__tests__/profile-facts.service.spec.ts --runInBand; cd apps/eva-dashboard && npm test -- --runInBand __tests__/soul-editor.test.tsx; cd apps/eva-core && npm run build; cd apps/eva-dashboard && npm run build; npm run docs:check
P: pending/improve -> apply migration 033 to Supabase and run RLS_TEST=true npm run test:e2e to verify profile_private_items.ciphertext is unreadable through authenticated Data API

### 2026-06-12 23:47Z
C: agent/settings: added tier step budgets, Spanish suffix routing coverage, and curated active backlog; files=apps/eva-core/src/agent/tier.ts,apps/eva-core/src/agent/agent-intelligence.service.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts,apps/eva-core/src/agent/__tests__/agent-intelligence.service.spec.ts,apps/eva-dashboard/components/settings/agent-client.tsx,supabase/migrations/032_agent_tier_step_settings.sql,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- src/agent/__tests__/agent-intelligence.service.spec.ts --runInBand; cd apps/eva-core && npm test -- src/agent/__tests__/agent-runner.service.spec.ts --runInBand; cd apps/eva-dashboard && npm run build; npm run docs:check
P: pending/improve -> apply migrations 031-032 to Supabase and run RLS_TEST=true npm run test:e2e before relying on private context and tier-step settings in production

### 2026-06-12 23:42Z
C: profile-hub: plan detallado (sin código) para extraer Mi Perfil de /soul a /profile, unificar con vault privado (auto-hide + masking), tablas profile_todos/notes/goals, auto-llenado via digester v2 + tools del loop, ProfileContextBuilder para prompts; files=docs/profile_hub_plan.md,docs/backlog.md; tests=n/a (solo planeación)
P: pending/improve -> implementar Fase 1 del profile hub: migración 033_profile_hub.sql + SensitivityClassifierService + ProfileFactsService + ProfileController con tests RLS

### 2026-06-12 23:20Z
C: dashboard/soul: redesigned Soul editor into separated Agente EVA, Mi perfil, and Privado sections with vault-style private context fields; files=apps/eva-dashboard/components/soul/soul-editor.tsx,apps/eva-dashboard/__tests__/soul-editor.test.tsx,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-dashboard && npm test -- --runInBand __tests__/soul-editor.test.tsx; cd apps/eva-dashboard && npm run build; npm run docs:check
P: pending/improve -> verify Soul segmented workspace in a real browser session after migration 031 is applied

### 2026-06-12 23:15Z
C: dashboard/docs: implemented high-impact backlog items: Playground thumbs feedback, Topbar core/sandbox health indicator, and project-map freshness checker; files=apps/eva-dashboard/components/playground/playground-client.tsx,apps/eva-dashboard/__tests__/playground.test.tsx,apps/eva-dashboard/components/layout/topbar.tsx,scripts/check-project-map-freshness.mjs,package.json,docs/backlog.md,docs/architecture.md,.agents/skills/eva-project-seed/references/project-map.md; tests=npm run docs:check; cd apps/eva-dashboard && npm test -- --runInBand __tests__/playground.test.tsx; cd apps/eva-dashboard && npm run build; cd apps/eva-core && npm run build; cd apps/eva-core && npm test -- src/agent/__tests__/soul-context.service.spec.ts --runInBand
P: pending/improve -> add docs:check to CI and consider a Topbar unit test with mocked /health states

### 2026-06-12 22:55Z
C: soul: separated agent identity from user profile, added relationship alias map and encrypted private user context for model-only prompting; files=apps/eva-core/src/agent/soul-context.service.ts,apps/eva-core/src/agent/soul.controller.ts,apps/eva-core/src/agent/dto/private-soul-context.dto.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/soul-context.service.spec.ts,apps/eva-dashboard/components/soul/soul-editor.tsx,apps/eva-dashboard/lib/types.ts,apps/eva-dashboard/app/(dashboard)/soul/page.tsx,supabase/migrations/031_soul_private_context.sql,docs/architecture.md,docs/backlog.md,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- src/agent/__tests__/soul-context.service.spec.ts --runInBand; cd apps/eva-core && npm run build; cd apps/eva-dashboard && npm run build
P: pending/improve -> apply migration 031 in a real Supabase environment and run RLS_TEST=true npm run test:e2e to verify ciphertext column grants

### 2026-06-12 21:58Z
C: docs: restructured docs folder to a compact, new set of files, deleted old guides, and implemented a closed-loop living documentation system; files=docs/architecture.md,docs/process_flows.md,docs/implementation_guide.md,docs/project_sections.md,docs/improvement_loop.md,docs/backlog.md,.agents/skills/eva-project-seed/SKILL.md,.agents/skills/eva-project-seed/references/project-map.md; tests=manual review, git status
P: pending/improve -> add a sanity check script to verify all links in the restructured markdown documentation remain valid

### 2026-06-12 20:43Z
C: agent-loop: added explicit authorization instructions to system prompt and refinement layer to prevent false capability/privacy refusals on WhatsApp/Gmail tools; files=apps/eva-core/src/agent/agent-loop.service.ts; tests=npm test
P: pending/improve -> verify if other model providers (like Claude or GPT) require similar system prompt overrides for capability verification

### 2026-06-12 20:24Z
C: agent: implemented general planning horizons router supporting short, medium, and long term tiers; files=apps/eva-core/src/agent/tier.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts; tests=npm test -- src/agent/__tests__/agent-runner.service.spec.ts
P: pending/improve -> add setting controls in agent Settings page to customize maxSteps limits for different tiers

### 2026-06-12 20:03Z
C: Refactored EVA Agentic Platform: declarative router, unified loop tools with Zod schemas, DoD acceptance criteria, editable approvals, parallel sub-agents with blackboard, semantic history compression, memory similarity clustering, and dashboard autonomy boundaries + telemetry metrics; files=agent-loop.service.ts, agent-intelligence.service.ts, agent-runner.service.ts, approvals.service.ts, approval-classifier.service.ts, sidebar.tsx, page.tsx, agent-client.tsx, dashboard-view-cache.tsx; tests=npm test in apps/eva-core, npm test in apps/eva-dashboard
P: pending/improve -> Verify next dashboard integration under real organization traffic, audit RLS logs for memory consolidator batch runs

### 2026-06-12 19:37Z
C: agent intelligence: implemented remaining roadmap flywheels (plan state, ask_user resume/timeout, replay, skill embeddings/dedupe, safety limits, security gate, memory/self-improvement/heartbeat tick); files=apps/eva-core/src/agent/agent-intelligence.service.ts,apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/skill-library.service.ts,supabase/migrations/029_agent_intelligence_flywheels.sql,supabase/migrations/014_rls_policies.sql; tests=cd apps/eva-core && npm run eval:agent && npm test -- --runInBand && npm run lint && npm run build
P: pending/improve -> move AgentIntelligenceService in-process autonomy tick to explicit scheduled_jobs rows for easier dashboard inspection and operational control

### 2026-06-12 19:21Z
C: agent intelligence: trajectory persistence, metrics endpoint, adaptive budget, parallel read-only tool calls, golden eval harness; files=apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/agent-trajectory.service.ts,apps/eva-core/src/agent/agent-metrics.controller.ts,apps/eva-core/evals/golden-tasks.json,apps/eva-core/scripts/agent-evals.ts,supabase/migrations/028_agent_intelligence_metrics.sql,supabase/migrations/014_rls_policies.sql; tests=cd apps/eva-core && npm test -- --runInBand && npm run eval:agent && npm run lint && npm run build
P: pending/improve -> implement full ask_user resume channel and automatic startup resume from running agent_trajectories checkpoints

### 2026-06-12 17:14Z
C: agent: fallback telegram chatId resolution to communication_accounts when metadata is empty; files=apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/__tests__/agent-loop.service.spec.ts; tests=npm test -- agent-loop.service.spec.ts
P: pending/improve -> add e2e or integration test verifying playground task fallback for communication accounts

### 2026-06-12 17:03Z
C: agent: refine code_execute tool usage and system prompt download rules to force network: true; files=apps/eva-core/src/agent/agent-loop.service.ts; tests=npm test -- agent-loop.service.spec.ts
P: pending/improve -> monitor model code execution for network: true parameter compliance

### 2026-06-12 17:01Z
C: agent: fix sandbox persistent network session and share hostDir workspace; files=apps/eva-core/src/agent/sandbox.service.ts,apps/eva-core/src/agent/agent-loop.service.ts; tests=npm test -- sandbox.service.spec telegram.adapter.spec agent-loop.service.spec --runInBand
P: pending/improve -> add a test covering sandbox volume concurrency/release safety under stress

### 2026-06-12 16:52Z
C: agent: loop robustness with balanced budget and yt-dlp/ffmpeg system instructions; files=apps/eva-core/src/agent/agent-loop.service.ts; tests=npm test -- agent-loop.service.spec
P: pending/improve -> verify media downloading using yt-dlp on a real YouTube / Platzi link end-to-end

### 2026-06-12 16:46Z
C: communication/agent-learning: Telegram final outbound messages now persist task_id and short praise/correction replies infer agent feedback for latest conversation task via skill reward graph; files=apps/eva-core/src/communication/communication.service.ts,apps/eva-core/src/communication/communication.repository.ts,apps/eva-core/src/communication/communication.module.ts,apps/eva-core/src/events/event-bus.service.ts,apps/eva-core/src/communication/__tests__/communication.service.spec.ts,.agents/skills/eva-project-seed/references/project-map.md; tests=cd apps/eva-core && npm test -- --runInBand src/communication/__tests__/communication.service.spec.ts src/agent/__tests__/skill-library.service.spec.ts && npm run build && npm test -- --runInBand && npm run lint
P: pending/improve -> add dashboard/playground thumbs UI that calls POST /agent/feedback explicitly and add RLS_TEST coverage after applying skill learning migrations

### 2026-06-12 16:45Z
C: dashboard/mcp: expanded bundled MCP repository to 30 agent-focused presets and added category filters; files=apps/eva-dashboard/lib/mcp-catalog.ts,apps/eva-dashboard/components/mcp/mcp-client.tsx,apps/eva-dashboard/__tests__/mcp.test.tsx; tests=cd apps/eva-dashboard && npm test -- --runInBand __tests__/mcp.test.tsx && npm run lint && npm test -- --runInBand && npm run build
P: pending/improve -> wire runner-side stdio env/secret injection for catalog presets that need DATABASE_URL, REDIS_URL, provider tokens, or OAuth

### 2026-06-12 11:31Z
C: agent: prefix-based tier signals in tier.ts for inflected Spanish verbs; files=apps/eva-core/src/agent/tier.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts; tests=npm test -- apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts
P: pending/improve -> ensure all Spanish action verbs with trailing pronouns/suffixes are matched by the regex and test more complex phrasing combinations

### 2026-06-12 11:25Z
C: sandbox: warm-up retry loop (20x/30s), warmUpStatus export, health endpoint reports sandbox status, docker-compose mounts /var/run/docker.sock + eva-sandbox-builder service; files=apps/eva-core/src/agent/sandbox.service.ts,apps/eva-core/src/agent/agent.module.ts,apps/eva-core/src/health/health.controller.ts,apps/eva-core/src/health/health.module.ts,docker-compose.yml,apps/eva-core/src/agent/__tests__/sandbox.service.spec.ts; tests=cd apps/eva-core && npm test -- src/agent/__tests__/sandbox.service.spec.ts --runInBand && npm run build
P: pending/improve -> verify docker socket mount works on Linux server; check eva-sandbox-builder pulls docker:cli image in CI; add /health sandbox field to dashboard status indicator

### 2026-06-12 11:22Z
C: agent: real agency — network sandbox sessions, yt-dlp+ffmpeg in eva-sandbox image, TelegramAdapter.sendDocument(), sandbox_ls and telegram_send_file tools in AgentLoopService, TelegramAdapter exported from CommunicationModule; files=docker/sandbox/Dockerfile,apps/eva-core/src/agent/sandbox.service.ts,apps/eva-core/src/communication/telegram.adapter.ts,apps/eva-core/src/communication/communication.module.ts,apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/communication/__tests__/telegram.adapter.spec.ts,apps/eva-core/.env.example; tests=cd apps/eva-core && npm test -- communication/__tests__/telegram.adapter.spec.ts agent/__tests__/sandbox.service.spec.ts --runInBand && npm run build && npm test -- --runInBand
P: pending/improve -> verify yt-dlp download + telegram_send_file end-to-end with a real YouTube URL via Telegram bot; also check ffmpeg compression path for videos >50MB

### 2026-06-12 11:04Z
C: agent: fix search normalization query context history leakage loop; files=apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts; tests=npm test -- apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts
P: pending/improve -> add broader e2e integration tests for search normalization under multiple conversation turns

### 2026-06-12 10:51Z
C: communication/telegram: accept photo/image documents plus voice/audio webhooks, upload inbound files to eva-media, transcribe audio via org OpenAI key, and create agent-ready tasks without storing Telegram token URLs; files=apps/eva-core/src/communication/communication.service.ts,apps/eva-core/src/communication/communication.types.ts,apps/eva-core/src/communication/telegram.adapter.ts,apps/eva-core/src/communication/__tests__/communication.service.spec.ts,apps/eva-core/src/communication/__tests__/telegram.adapter.spec.ts; tests=cd apps/eva-core && npm test -- communication/__tests__/communication.service.spec.ts communication/__tests__/telegram.adapter.spec.ts --runInBand && npm run build && npm test -- --runInBand && npm run lint
P: pending/improve -> real Telegram webhook smoke test with a live bot should verify file download size limits, OpenAI transcription model availability, and vision response quality on uploaded photos

### 2026-06-12 10:44Z
C: dashboard/mcp: added bundled MCP repository presets with one-click connect actions in the MCP page; files=apps/eva-dashboard/components/mcp/mcp-client.tsx,apps/eva-dashboard/lib/mcp-catalog.ts,apps/eva-dashboard/__tests__/mcp.test.tsx; tests=cd apps/eva-dashboard && npm test -- --runInBand __tests__/mcp.test.tsx && npm run lint && npm test -- --runInBand && npm run build
P: pending/improve -> verify catalog endpoint freshness and OAuth flows before adding more remote MCP providers

### 2026-06-12 10:18Z
C: agent: integrated runtime skill catalog selection with usage/concurrency stats, learned graph outcomes, delegated roles, and org-scoped learning tables; files=apps/eva-core/src/agent/bundled-skills.catalog.ts,apps/eva-core/src/agent/skill-library.service.ts,apps/eva-core/src/agent/agent-loop.service.ts,supabase/migrations/027_skill_learning_graph.sql; tests=npm test -- agent/__tests__/skill-library.service.spec.ts agent/__tests__/agent-loop.service.spec.ts --runInBand && npm run build && npm test -- --runInBand && npm run lint
P: pending/improve -> add RLS_TEST coverage for skill_usage_stats/skill_graph_edges/skill_selection_events after applying migration 027 to the real Supabase project

### 2026-06-12 10:12Z
C: seed: quick_validate passed for eva-project-seed; files=.agents/skills/eva-project-seed; tests=python3 /Users/djoker/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/eva-project-seed
P: pending/improve -> add a freshness checker that diffs migrations/controllers/module imports against project-map before future seed updates

### 2026-06-12 10:11Z
C: seed: validated mandatory update workflow for new EVA compact project seed; files=.agents/skills/eva-project-seed/SKILL.md,.agents/skills/eva-project-seed/references/project-map.md,.agents/skills/eva-project-seed/references/change-log.md,.agents/skills/eva-project-seed/scripts/update_seed.py; tests=python3 update_seed.py manual run
P: pending/improve -> run quick_validate and consider adding an automated freshness checker that compares migrations/controllers against project-map

### 2026-06-12 09:44Z
C: agent: add chat-based approval and rejection interceptor and improve WhatsApp draft confirmation prompt; files=apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts; tests=npm test
P: pending/improve -> E2E testing of chat-based approvals on real platforms

### 2026-06-12 09:34Z
C: agent: add image_analyze tool with vision support; files=apps/eva-core/src/agent/agent-loop.service.ts,apps/eva-core/src/agent/sandbox.service.ts,apps/eva-core/src/agent/__tests__/agent-loop.service.spec.ts; tests=npm test
P: pending/improve -> Expand unit tests for image_analyze local file resolution

### 2026-06-12 09:26Z
C: whatsapp: added vision OCR analysis fallback to read/reason from screenshots, updated input/send button selectors, and support suffix verbs/implicit drafting; files=apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/integrations/whatsapp-web.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts; tests=npm test -- src/agent/__tests__/agent-runner.service.spec.ts src/integrations/__tests__/whatsapp-web.service.spec.ts
P: pending/improve -> add actual E2E testing of the vision OCR fallback on real screenshots

### 2026-06-12 09:10Z
C: whatsapp: added robust contact cleaning and fuzzy matching scoring logic to ignore headers/section sections; files=apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/integrations/whatsapp-web.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts,apps/eva-core/src/integrations/__tests__/whatsapp-web.service.spec.ts; tests=npm test -- src/agent/__tests__/agent-runner.service.spec.ts src/integrations/__tests__/whatsapp-web.service.spec.ts
P: pending/improve -> add actual E2E testing of the fuzzy matching algorithm on real WhatsApp Web layouts

### 2026-06-12 09:02Z
C: agent: active tool session tracking and compressing conversation history memory; files=apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts; tests=npm test -- src/agent/__tests__/agent-runner.service.spec.ts
P: pending/improve -> reconcile task metadata vs db-loaded task history across other channels

### 2026-06-12 08:47Z
C: whatsapp: fixed active chat header targeting to prevent matching sidebar header, robust innerText name fallback, and extracted visible search results list on selection failure; files=apps/eva-core/src/integrations/whatsapp-web.service.ts,apps/eva-core/src/integrations/__tests__/whatsapp-web.service.spec.ts; tests=npm test -- src/integrations/__tests__/whatsapp-web.service.spec.ts
P: pending/improve -> add actual integration/E2E test suite using true chrome profiles for WhatsApp Web flow

### 2026-06-12 08:23Z
C: whatsapp: fixed contact selection click failures by implementing verified open headers, dual-clicks (native+JS), and clearSearchInput; files=apps/eva-core/src/integrations/whatsapp-web.service.ts,apps/eva-core/src/integrations/__tests__/whatsapp-web.service.spec.ts; tests=npm test -- src/integrations/__tests__/whatsapp-web.service.spec.ts
P: pending/improve -> add actual integration/E2E test suite using true chrome profiles for WhatsApp Web flow

### 2026-06-12 08:07Z
C: whatsapp: added sendMessage, improved search input selectors, resolved approvals execution loop; files=apps/eva-core/src/integrations/whatsapp-web.service.ts,apps/eva-core/src/agent/agent-runner.service.ts,apps/eva-core/src/browser/whatsapp-web.controller.ts,apps/eva-core/src/integrations/__tests__/whatsapp-web.service.spec.ts,apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts; tests=npm test -- apps/eva-core/src/integrations/__tests__/whatsapp-web.service.spec.ts,npm test -- apps/eva-core/src/agent/__tests__/agent-runner.service.spec.ts
P: pending/improve -> add end-to-end integration tests for WhatsApp Web message flows with real browser sessions if possible

### 2026-06-12 05:43Z
C: agent: added real-time status announcements and thinking response refinement layer to AgentLoopService; files=apps/eva-core/src/agent/agent-loop.service.ts; tests=npm test --workspace=apps/eva-core
P: pending/improve -> verify the real-time messages and response quality in the playground with a web_search query

### 2026-06-12 05:33Z
C: infra: killed stale scratch processes from previous sessions stealing Redis stream events; files=n/a; tests=n/a
P: pending/improve -> prevent local scratch scripts from consuming on the main group 'eva-core' by using separate consumer groups or unique consumer names

### 2026-06-12 00:00Z
C: seed -> created `eva-project-seed` skill with project map, mandatory update protocol, and update script; files=.agents/skills/eva-project-seed/*; tests=quick_validate pending
P: reconcile docs/schema drift -> AGENTS/README say migrations through 015 and RLS only in 014, but repo has 001-027 and later policy migrations; also verify `task_steps` reference and `tasks.findStuck` org scope.
