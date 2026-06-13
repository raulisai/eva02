# EVA · Process Flows

This document details the main operational flows of the EVA Agentic Platform using Mermaid diagrams.

## 1. Task State Machine

The task transitions from creation to completion or failure. Non-terminal states can be cancelled at any point.

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> planning : Start processing
    pending --> cancelled : Cancelled by user
    
    planning --> running : Plan generated & approved
    planning --> failed : Planning error
    planning --> cancelled : Cancelled by user
    
    running --> completed : Execution success
    running --> failed : Execution error
    running --> waiting_for_approval : Sensitive action detected (Level 1-3)
    running --> waiting_for_input : User feedback/clarification requested
    running --> cancelled : Cancelled by user
    
    waiting_for_approval --> running : Approved by user
    waiting_for_approval --> completed : Action directly resolved (e.g. bypass)
    waiting_for_approval --> failed : Rejected by user
    waiting_for_approval --> cancelled : Cancelled by user
    
    waiting_for_input --> running : Response received
    waiting_for_input --> completed : Input resolved task directly
    waiting_for_input --> failed : Input timeout / error
    waiting_for_input --> cancelled : Cancelled by user
    
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
```

---

## 2. Core Agent Loop (`AgentLoopService`)

The step-by-step loop execution for planning, action selection, sandbox run, and reflection.

```mermaid
flowchart TD
    Start([Receive Task]) --> CheckMemory[Search Memory via pgvector]
    CheckMemory --> GeneratePlan[Generate Implementation Plan]
    
    subgraph ExecutionLoop [Agent Execution Loop]
        CheckBudget{Budget & Steps Remaining?}
        CheckBudget -- No / Out of limit --> FailTask[Mark Task as Failed]
        CheckBudget -- Yes --> SelectAction[Determine next Tool Call / Step]
        
        SelectAction --> CheckApproval{Sensitive Tool? Level >= 1}
        CheckApproval -- Yes --> CreateApproval[Create Approval Request]
        CreateApproval --> WaitForUser{User Response?}
        WaitForUser -- Approved --> ExecuteTool[Execute Tool]
        WaitForUser -- Rejected --> FailTask
        
        CheckApproval -- No --> ExecuteTool
        
        ExecuteTool --> SandboxExecute{Is Code execution?}
        SandboxExecute -- Yes --> SpwanDocker[Run inside Docker Sandbox Container]
        SandboxExecute -- No --> RunLocal[Run via local runner / playwight / mcp]
        
        SpwanDocker --> CaptureResult[Capture Stdin/Stdout & Mask Secrets]
        RunLocal --> CaptureResult
        
        CaptureResult --> Reflect[Reflect & Update Trajectory Log]
        Reflect --> TaskDone{Task Completed?}
        TaskDone -- No --> CheckBudget
    end
    
    TaskDone -- Yes --> Consolidate[Consolidate Memories & Update Skill Graph]
    Consolidate --> Complete([Mark Task as Completed])
```

---

## 3. Fast Path & Watch UI Communication

Ephemeral watch interactions designed for real-time speech and instant reactive tasks.

```mermaid
sequenceDiagram
    participant Watch as Wear OS Watch
    participant Core as EVA Core API
    participant WS as WebSocket Gateway
    participant LLM as OpenAI Realtime API

    Watch->>Core: Request Ephemeral Token (TTL 300s, actions_allowed=false)
    Core-->>Watch: Return JWT token
    Watch->>WS: Connect WebSocket with JWT
    WS->>WS: Validate token & fetch org_id
    
    Note over Watch, WS: Fast Path established (Audio / Vibe / Fast state)
    Watch->>WS: Send voice stream (User query)
    WS->>LLM: Forward stream to Realtime Session
    LLM-->>WS: Return raw audio buffer
    WS-->>Watch: Send raw audio / Server-Driven UI (SDUI)
    
    Note over Watch, WS: Connection closes automatically on TTL expiration
```

---

## 4. Approval Engine Validation Flow

Securing sensitive capabilities (data deletion, financial payments, deployments).

```mermaid
sequenceDiagram
    participant Agent as Agent Loop
    participant Approvals as ApprovalEngineService
    participant DB as Postgres (RLS Scoped)
    participant User as Web Dashboard / Telegram

    Agent->>Approvals: Request approval (level, action_payload)
    Approvals->>Approvals: Normalize payload
    Approvals->>Approvals: Generate action_hash = sha256(payload + nonce)
    Approvals->>DB: Save approval row (status = pending)
    Approvals-->>Agent: Throw WaitingForApprovalException
    
    Note over Agent: Loop pauses & persists checkpoint trajectory
    
    User->>Approvals: POST /approvals/:id/approve (JWT + Signature)
    Approvals->>DB: Validate user org_id matches approval org_id
    Approvals->>DB: Update approval row (status = approved)
    Approvals->>Agent: Requeue task to running queue
    
    Note over Agent: Loop resumes, matches action_hash & runs action
```

### Conversational Approval UX (Telegram / chat)
- The approval ask is **one short human message**: what will be executed + `responde "sí" o "no"`. No hashes, levels, expiry, or screenshot links reach the user.
- Flows that already deliver their own conversational ask (runner WhatsApp/Gmail/Calendar handlers) create the approval with `notify: false` so the Communication Hub does not send a duplicate message; agent-loop tools keep the default notification and instruct the model to close with a brief confirmation.
- `APPROVE_KEYWORDS` / `REJECT_KEYWORDS` in `agent-runner.service.ts` accept natural replies ("sí, envíalo", "dale", "mejor no", "cancélalo") and resolve the latest pending approval; `approval.resolved` then triggers `executeApprovedAction`.
- **Evidence on demand only**: screenshots/images are sent only when the user explicitly asked for them (`wantsEvidence()` in `agent/evidence.ts`, persisted as `payload.send_evidence` on the approval). The WhatsApp QR is the exception — it is always sent when linking is required.
- Long-tier tasks emit a short ack (`task.say`) **before** soul/agenda/memory context loading, so the user hears EVA in <1s.
