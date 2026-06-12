# EVA Runtime Skill Policy

All bundled runtime skills must follow these rules:

- Keep the workflow scoped to its named purpose.
- Preserve EVA multi-tenancy: tenant data access needs an `org_id` boundary.
- Do not bypass Supabase RLS, the JWT guard, or the Approval Engine.
- Do not expose secrets, tokens, private user data, or tenant data in prompts, examples, logs, metadata, or generated files.
- Treat external writes as approval-gated: production changes, money actions, account changes, messaging, email, social posting, issue/PR mutations, deploys, installs, and destructive commands.
- Prefer read-only local analysis and explicit verification steps.
- Do not include literal prompt-injection phrases or instructions that attempt to override higher-priority system/developer policy.
- Do not depend on another agent framework's private tools or paths unless the instructions are adapted to EVA.
