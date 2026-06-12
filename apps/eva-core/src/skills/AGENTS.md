# EVA Runtime Skills DOX

## Purpose

- Own the curated runtime skills that EVA can load to guide agent decisions.
- Keep skill workflows accurate, composable, tenant-safe, and safe for runtime loading.

## Ownership

- Each direct skill directory owns its `SKILL.md` and any local supporting files.
- Plugin-distributed skills belong under the relevant plugin directory.
- User-local skills belong under `usr/skills/`.

## Local Contracts

- Every skill directory must include a `SKILL.md`.
- Skill instructions must be operational and scoped to the skill's purpose.
- Do not include secrets, private user data, or environment-specific credentials.
- Supporting files referenced by a skill must exist relative to that skill directory.
- Skills must not instruct EVA to bypass auth, RLS, tenant isolation, the Approval Engine, or user approvals.
- Skills that mention external services must be read/research oriented unless they explicitly require approval before writes.
- Avoid platform-specific instructions from other agent frameworks unless adapted to EVA's runtime.

## EVA Safety Baseline

- Tenant data requires an `org_id` boundary.
- Production, money, destructive, account-changing, social-posting, messaging, email-sending, and secret-changing actions require explicit approval.
- Secrets stay in env vars or the secret manager; skills must never ask the agent to print, scrape, infer, or persist credentials.
- Prefer local/read-only inspection. If a workflow needs network, installs, file mutation, or third-party account writes, the skill must call that out as approval-gated.
- Runtime skills are decision support, not a replacement for tests, RLS policies, migrations, or code review.

## Work Guidance

- Keep skills focused on repeatable workflows that agents should actively follow.
- Prefer updating an existing skill over creating overlapping skill variants.
- When a skill refers to repository paths, commands, or plugin architecture, keep those references current with source and docs.

## Verification

- Run skill runtime/import tests after changing skill loading assumptions or skill format.
- Manually read changed `SKILL.md` files for broken relative references.

## Child DOX Index

No child DOX files.
