# EVA Seed Change Log

Newest first. Every use of `$eva-project-seed` must add one `C:` and one `P:` entry. Keep it compact and exact.

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
