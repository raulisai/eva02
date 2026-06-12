# EVA Seed Change Log

Newest first. Every use of `$eva-project-seed` must add one `C:` and one `P:` entry. Keep it compact and exact.

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
