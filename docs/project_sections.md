# EVA · Project Sections & Directory Map

This document acts as a syllabus and structural guide mapping the codebase modules, folders, and responsibilities.

---

## 1. Monorepo Layout

```
eva/
├── apps/
│   ├── eva-core/             # NestJS API Backend
│   └── eva-dashboard/        # Next.js 14 Web Panel
├── packages/
│   ├── browser-runtime/      # Playwright Automation Wrapper
│   ├── mcp-adapters/         # Model Context Protocol Adapter Bundle
│   └── skill-runtime/        # Local Skill Loader & Sandbox Package
├── docker/                   # Postgres init & sandbox Dockerfiles
├── supabase/
│   └── migrations/           # SQL migration scripts (001 - 029)
└── docs/                     # Restructured project documentation
```

---

## 2. Backend API Modules (`apps/eva-core/src/`)

| Module | Location | Description / Responsibilities |
|---|---|---|
| **agent** | `src/agent/` | The core agentic loop (`AgentLoopService`), horizon routing (`tier.ts`), execution budget controls, sandbox manager (`SandboxService`), telemetry tracking (`AgentTrajectoryService`), and self-improvement flywheels. |
| **approvals** | `src/approvals/` | Request-response flow for sensitive actions (Levels 0-3) using cryptographically verified `action_hash` signatures. |
| **auth** | `src/auth/` | Supabase JWT token verification, Passport strategies, and request user-context mount guards. |
| **browser** | `src/browser/` | Controls local Playwright sessions, performs action predictions, and takes telemetry screenshots. |
| **communication**| `src/communication/` | Connectors for Telegram, Discord, and Email webhooks; processes outbound message dispatching. |
| **database** | `src/database/` | Exposes `DatabaseService` which supplies admin clients or scoped clients (`forUser(jwt)`). |
| **dev-control** | `src/dev-control/` | Command-line execution bridge to compile, run tests, suggested roadmaps, and host Claude Code controller sessions. |
| **events** | `src/events/` | EventBus publisher and subscriber backed by Redis Streams (`eva:events`). |
| **gateway** | `src/gateway/` | Socket.io WebSocket server (`/eva`) managing real-time notifications and Wear OS UI sync. |
| **integrations** | `src/integrations/` | Connectors for external providers: Google Drive, Gmail, WhatsApp Web, Uber, and remote MCP nodes. |
| **intent-router**| `src/intent-router/` | Categorizes user requests into fast speech execution paths or deep agentic planning runs. |
| **jobs** | `src/jobs/` | Cron schedules, interval orchestrators, and job queues. |
| **memory** | `src/memory/` | Vectors management (using pgvector), similarity matches, and long-term memory consolidation. |
| **model-router** | `src/model-router/` | Abstracts LLM providers behind unified completion interfaces. |
| **planner** | `src/planner/` | Dynamic step planner calculating required horizons based on task length. |
| **skills** | `src/skills/` | Skill registry library, tool mapping selectors, and bundled presets. |
| **tasks** | `src/tasks/` | Task status model state machine, including `waiting_for_input` pauses and `waiting_for_approval` gates. |
| **tool-router** | `src/tool-router/` | Schema catalogs and routing logic for MCP tools. |
| **wear-fast-path**| `src/wear-fast-path/`| Distributes ephemeral 300s tokens for direct watch-to-LLM audio streaming. |

---

## 3. Web Dashboard Routes (`apps/eva-dashboard/app/(dashboard)/`)

- `/tasks`: Visualizes task listings, real-time log consoles, step trajectories, and input request prompts.
- `/approvals`: Form interfaces to approve or reject pending sensitive actions (Level 1-3).
- `/playground`: Interactively test prompt inputs, intent routers, and watch the agent trace lines in real-time.
- `/soul`: Soul profile customization, parameters setting, and memory registry.
- `/skills`: Catalog of loaded agentic capabilities and execution graphs.
- `/jobs`: Configured cron jobs status and scheduling panel.
- `/nodes`: Active node workers monitoring CPU, battery, status, and capabilities.
- `/mcp`: Register and monitor Model Context Protocol tool connectors.
- `/billing`: Telemetry logs of tokens spent, model costs, and budgets.
- `/events`: Raw audit stream of Redis task events.
