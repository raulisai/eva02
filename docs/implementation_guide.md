# EVA · Implementation Guide

This guide details the development rules, database practices, and local environment specifications for building on the EVA Agentic Platform.

---

## 1. Multi-Tenant Tenancy Rules

**EVA is strictly multi-tenant.** Every query and transaction must be partitioned by an organization ID (`org_id`).

### The Golden Rule
> [!CAUTION]
> **Never query the database without filtering by `org_id`.**
> Any leak of data across organizations is a critical security vulnerability.

- **Entity Pattern**: Every new database table must include `org_id uuid not null references organizations(id) on delete cascade`.
- **Query Scopes**:
  - Direct repository calls must filter with `.eq('org_id', orgId)` or payload equivalents.
  - When querying as the service-role client (Supabase admin), you must manually append the `orgId` filters:
    ```typescript
    await this.supabase.from('tasks').select('*').eq('org_id', orgId);
    ```
- **Context Injection**:
  - **HTTP requests**: The `JwtAuthGuard` extracts the user's JWT, validates it, and mounts `req.user.orgId` in NestJS context.
  - **WebSockets**: The socket gateway authenticates via connection query params and queries the `users` table to resolve the associated `org_id`.

---

## 2. Row Level Security (RLS)

All tables must have RLS active. 
- **Enabling RLS**: New tables must execute `ALTER TABLE <table_name> ENABLE ROW LEVEL SECURITY;`.
- **Standard Policy**: The standard RLS policy isolates records based on the user's `org_id`:
  ```sql
  CREATE POLICY org_isolation ON <table_name>
    FOR ALL
    USING (org_id = ((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text)::uuid);
  ```
- **File Convention**: Although the codebase has later migrations creating policies (such as `015_...`), the primary RLS registry is `supabase/migrations/014_rls_policies.sql`. Keep this file updated or document additions.

---

## 3. Environment Variables (Required)

Ensure the following variables are defined in your local `.env` file (copied from `.env.example`):

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase Cloud API Base URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin bypass key (keep safe, never expose to frontends) |
| `DATABASE_URL` | Postgres direct connection string |
| `REDIS_URL` | Redis server address (e.g., `redis://localhost:6379`) |
| `OPENAI_API_KEY` | OpenAI API access token |
| `ANTHROPIC_API_KEY` | Anthropic Claude API access token |
| `NODE_JWT_SECRET` | Signing secret for remote node authentications |
| `EVA_MASTER_KEY` | Envelope encryption master key for sensitive credentials |
| `TELEGRAM_BOT_TOKEN` | Bot Father key for Telegram integrations |

---

## 4. Local Development & Testing

### Running Locally
1. Start the Redis instance (Postgres remains cloud-hosted in Supabase):
   ```bash
   docker compose up -d redis
   ```
2. Set up environments:
   ```bash
   cp apps/eva-core/.env.example apps/eva-core/.env
   # Populate apps/eva-core/.env with correct keys
   ```
3. Install and run backend:
   ```bash
   cd apps/eva-core && npm install && npm run start:dev
   ```
4. Install and run dashboard:
   ```bash
   cd apps/eva-dashboard && npm install && npm run dev
   ```

### Execution of Tests
- **Backend Unit Tests**:
  ```bash
  cd apps/eva-core && npm test
  ```
- **Backend Integration / E2E Tests (Mocked DB)**:
  ```bash
  cd apps/eva-core && npm run test:e2e
  ```
- **Real Supabase RLS Tests**:
  ```bash
  cd apps/eva-core && RLS_TEST=true npm run test:e2e
  ```
- **Telemetry Evals**:
  ```bash
  cd apps/eva-core && npm run eval:agent
  ```

---

## 5. Security & Secret Protection

- **No Hardcoded Secrets**: Secrets should never be stored in source code, client repositories, or print statements.
- **Envelope Encryption**: Provider credentials, tokens, or custom browser sessions are encrypted at-rest in Supabase tables using AES-256-GCM via `EVA_MASTER_KEY`.
- **Dynamic Masking**: Stdin/stdout captured from sandbox runs or logs are automatically scanned for patterns containing `§§secret(...)` and redacted before storing or returning to dashboard viewports.
