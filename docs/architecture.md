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
- **Web Dashboard**: Built with Next.js 14 and Tailwind, interacting with the NestJS Core API via JWT token authentication.
- **Telegram Bot**: Listens to user webhook calls, routes tasks to the Intent Router, processes multi-modal feedback (voice transcription, photos), and returns telemetry updates.

### 2. NestJS Core API (`apps/eva-core`)
Orchestrates backend operations, models routing, memory management, and agent workflow state machines. Key components:
- **Intent Router**: Classifies incoming requests into either `Fast Path` (requires instant voice response) or `Core Path` (complex planning task).
- **Agent Loop / Runner**: An autonomous task-runner style system that plans, reflects, selects skills/tools, executes inside sandboxes, handles user input requests, and logs trajectories.
- **Memory Service**: Manages semantic memory with pgvector embeddings, executing similarity clustering and consolidated memories.
- **Model Router**: Abstracts LLM providers (Anthropic, OpenAI, local) behind a single standardized interface.

### 3. Execution & Integration Layer
- **Playwright Browser Runtime**: Handles web automation (like booking Uber rides or checking website states) using persistent browser profiles.
- **Docker Code Sandbox**: Spawns isolated containers per task to execute arbitrary python/node code with resource limits and transient workspaces.
- **MCP Adapters**: Integrates external tools using the Model Context Protocol (MCP).
- **Development Control Center**: Connects to the local repository, runs CLI commands, builds/tests, and bridges with Claude Code CLI sessions.

### 4. Coordination & Persistence Layer
- **Event Bus (Redis Streams)**: Communicates asynchronous transitions using `eva:events` to decouple long-running jobs and notify WebSocket consumers.
- **Supabase / Postgres Database**: Stores identity, tasks, memory embeddings, credentials, RLS policies, telemetry logs, and agent statistics.
- **Approval Engine**: Validates sensitive operations (Level 1-3) through cryptographic `action_hash` + `nonce` tokens before execution.
