# EVA · Architecture Overview

EVA is a highly distributed agentic platform built to perform complex, multi-modal tasks across remote environments, orchestrated by an autonomous agent loop and controlled via smart interfaces (like Wear OS watches or dashboards).

## System Architecture

```
                                  [ User Interfaces ]
                ┌───────────────────────┬───────────────────────┐
                ▼                       ▼                       ▼
           [ Wear OS ]            [ Web Dashboard ]        [ Telegram ]
         (Fast Path SDUI)         (Next.js 14 App)       (Inbound/Outbound)
                │                       │                       │
                └───────────────┬───────┴───────────────────────┘
                                ▼
                       [ API Gateway / WS ]
                                │
                      [ Intent Router (Fast/Core) ]
                                │
               ┌────────────────┴────────────────┐
               ▼                                 ▼
         [ Fast Path ]                    [ Core Agent Path ]
       (OpenAI Realtime)                  (Agent Loop Service)
               │                                 │
               │            ┌────────────────────┼────────────────────┐
               │            ▼                    ▼                    ▼
               │       [ Planner ]        [ Tool Router ]       [ Soul/Memory ]
               │     (Plan horizons)    (MCP / Local Tools)     (pgvector/Recall)
               │            │                    │                    │
               ▼            ▼                    ▼                    ▼
     ┌────────────────────────────────────────────────────────────────────────┐
     │                             Task Engine                                │
     │                  (Redis Streams & Event Bus Worker)                     │
     └──────────────────────────────────┬─────────────────────────────────────┘
                                        ▼
                         [ Remote Execution Modules ]
                 ┌──────────────────────┼──────────────────────┐
                 ▼                      ▼                      ▼
         [ Browser Worker ]      [ Dev Controller ]     [ Approval Gate ]
          (Playwright run)       (Claude / Sandbox)       (action_hash)
```

## Layer Descriptions

### 1. User Interfaces & Channel Connectors
- **Wear OS / Android Companion**: Uses Kotlin + Jetpack Compose. Communicates using a **Fast Path** (short-lived 300s tokens, zero storage of keys, raw OpenAI Realtime audio/vibration) or triggers Core actions via JSON Server-Driven UI (SDUI).
- **Web Dashboard**: Built with Next.js 14 and Tailwind, interacting with the NestJS Core API via JWT token authentication. Playground requests can attach consented browser geolocation as ephemeral task metadata (`request_context.location`) when the prompt needs current location or the user enables the location toggle.
- **Operations Header**: The dashboard topbar polls public `/health` to surface Core and sandbox readiness while WebSocket status tracks live event delivery.
- **Telegram Bot**: Listens to user webhook calls, routes tasks to the Intent Router, processes multi-modal feedback (voice transcription, photos), and returns telemetry updates.

### 2. NestJS Core API (`apps/eva-core`)
Orchestrates backend operations, models routing, memory management, and agent workflow state machines. Key components:
- **Intent Router**: Classifies incoming requests into either `Fast Path` (requires instant voice response) or `Core Path` (complex planning task).
- **Agent Loop / Runner**: An autonomous task-runner style system that plans, reflects, selects skills/tools, executes inside sandboxes, handles user input requests, and logs trajectories.
- **Request Location Context**: Core task metadata may include fresh device coordinates from the browser or Wear OS (`request_context.location`, with legacy `device_location` compatibility). The runner uses this for "where am I" answers, current-location weather/routing context, and Uber origins; missing or denied location is explicit rather than guessed from profile memory.
- **Delivery Guard**: For explicit deliverables such as “generate a PDF and send it to Telegram”, the root loop tracks required artifacts/actions, blocks premature `final_answer`, hard-caps repeated web searching, switches to delivery mode when the step budget is low, validates outgoing PDFs before Telegram delivery, and refuses a successful outcome while requested delivery remains pending.
- **Task Horizon Router**: Before routing, `AgentRunnerService` computes a `task_horizon` decision from `tier.ts`: immediate, background, scheduled, standby, or approval. The decision is persisted in task metadata, logged, and injected into the generic loop so long work uses checkpoints/tools, recurring work becomes visible Jobs, external waits park in `waiting_for_input`, and sensitive work stays behind Approval Engine.
- **Scheduled Autonomy**: Agent intelligence maintenance wakeups are explicit `scheduled_jobs` rows, visible and pausable in the Jobs dashboard; generated tasks carry the job payload so the runner can execute internal maintenance without spending model tokens.
- **Pipeline Runner** (`pipeline-runner.service.ts`): Detects multi-phase goals (pattern matching), decomposes them into an ordered `PipelineDefinition` via a cheap LLM call, then executes each phase as a separate `AgentLoop` invocation. Phase outputs are injected as context into subsequent phases via `{{outputKey}}` interpolation; the shared sandbox filesystem acts as a zero-copy file channel between phases. Route: `multi-phase-pipeline` at priority 43 in `AgentRunnerService`; retrying a failed pipeline task reuses `task.metadata.pipeline` and reruns only failed/skipped phases.
- **Memory / Soul / Profile Services**: Manage semantic memory with pgvector embeddings, agent identity, and the user-owned Profile Hub. `/soul` is agent identity; `/profile` stores structured todos, notes, goals, relationship/profile context, schedule context, and encrypted private vault items. Sensitive profile values are masked in normal tables and decrypted only by eva-core with reveal audit logs.
- **Model Router**: Abstracts LLM providers (Anthropic, OpenAI, local) behind a single standardized interface.

### 3. Execution & Integration Layer
- **Playwright Browser Runtime**: Handles web automation (like booking Uber rides or checking website states) using persistent browser profiles.
- **Uber Browser Flow**: Route preparation can resolve the origin from fresh request location and destination from `known_places` such as `work`; actual ride ordering remains approval-gated through `uber.ride.order`.
- **Docker Code Sandbox**: Spawns isolated containers per task to execute arbitrary python/node code with resource limits and transient workspaces.
- **MCP Adapters**: Integrates external tools using the Model Context Protocol (MCP).
- **Development Control Center**: Connects to the local repository, runs CLI commands, builds/tests, and bridges with Claude Code CLI sessions.

### 4. Coordination & Persistence Layer
- **Event Bus (Redis Streams)**: Communicates asynchronous transitions using `eva:events` to decouple long-running jobs and notify WebSocket consumers.
- **Supabase / Postgres Database**: Stores identity, tasks, memory embeddings, credentials, RLS policies, telemetry logs, and agent statistics.
- **Approval Engine**: Validates sensitive operations (Level 1-3) through cryptographic `action_hash` + `nonce` tokens before execution.
