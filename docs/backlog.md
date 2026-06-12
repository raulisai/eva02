# EVA · Living Backlog & Improvements

This backlog compiles outstanding tasks, technical debt, and improvement ideas compiled from recent development sessions. Agents must update this file as they resolve items or discover new tasks.

---

## 1. Agent Loop & Intelligence Flywheels
- [ ] **Scheduled Autonomy**: Migrate `AgentIntelligenceService` in-process intervals to explicit Postgres `scheduled_jobs` rows for better visibility.
- [ ] **Ask User Channel**: Build the full webhook/message resume channel and implement automatic startup resume from persisted `agent_trajectories` checkpoints.
- [ ] **Spanish Verbs regex**: Expand match rules in `tier.ts` to support inflected Spanish verbs with trailing pronouns or suffixes.
- [ ] **Model Provider Prompts**: Verify if non-Anthropic providers (like GPT or Claude) require similar system prompt overrides for tool capability/privacy verifications.
- [ ] **Sandbox Network Compliance**: Build telemetry to monitor models' compliance with `network: true` parameters.

---

## 2. Docker & Code Sandbox
- [ ] **Sandbox Concurrency**: Add stress tests checking workspace volume release safety and file locks under concurrent execution.
- [ ] **Host Docker Socket**: Verify host Docker socket mounts on production Linux environments.
- [ ] **Sandbox Builder**: Verify `eva-sandbox-builder` successfully pulls the required `docker:cli` base image in CI.

---

## 3. Communication & Integrations
- [ ] **Telegram Media Limits**: Test and verify webhook size limit check fallbacks, OpenAI transcriptions, and image OCR performance with live Telegram bot traffic.
- [ ] **Outbound Document Transfers**: Verify `yt-dlp` media download and `telegram_send_file` tool behaviors on actual YouTube URLs.
- [ ] **Ffmpeg Compression**: Wire a fallback compression routine for processing videos larger than 50MB.

---

## 4. MCP & Developer Controls
- [ ] **Dashboard Preset Envs**: Wire stdio env injection for dashboard catalog presets requiring `DATABASE_URL` or secret API tokens.
- [ ] **MCP Connection Auth**: Implement full OAuth authorization flow checks prior to adding additional remote MCP nodes.

---

## 5. Web Dashboard & UI
- [ ] **autonomy UI Controls**: Add dashboard controls to edit agent settings (e.g., `maxSteps` limits) by tier.
- [ ] **Autonomy Health Indicators**: Pipe the NestJS `/health` sandbox status field directly to the dashboard header.
- [ ] **Feedback Upvotes**: Add interactive "Thumbs Up/Down" buttons to the Playground UI calling `POST /agent/feedback`.

---

## 6. Testing & Quality Assurance
- [ ] **RLS Tests**: Run and verify `RLS_TEST=true npm run test:e2e` for the recent skill learning tables (`skill_usage_stats`, `skill_graph_edges`, `skill_selection_events`).
- [ ] **Soul Private Context RLS**: After applying migration `031_soul_private_context.sql`, verify `agent_souls.private_context_ciphertext` is not readable through the authenticated Supabase Data API and that eva-core can still decrypt it server-side.
- [ ] **Project Map Freshness Check**: Script an automated validator check comparing schema migrations and module controllers against `references/project-map.md`.
