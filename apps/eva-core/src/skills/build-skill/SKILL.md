---
name: build-skill
description: Build, audit, rename, or refactor EVA runtime skills under apps/eva-core/src/skills with safe SKILL.md metadata and scoped operational guidance.
---

## EVA Runtime Safety

Follow the EVA Runtime Skill Policy in `apps/eva-core/src/skills/RUNTIME_SKILL_POLICY.md`. Preserve `org_id` tenant boundaries, never expose secrets, and require explicit approval before external writes, destructive actions, production changes, money actions, messaging, social posting, installs, or credential changes.

# Build EVA Runtime Skill

Use this skill when a workflow should become reusable decision support for EVA.

## Safety Baseline

Follow `../RUNTIME_SKILL_POLICY.md`. EVA skills must not bypass auth, RLS, tenant isolation, the Approval Engine, or explicit user approval for external writes.

## Standard Shape

Each skill lives in a focused directory with a `SKILL.md` file:

```text
skill-name/
├── SKILL.md
├── scripts/      # optional deterministic helpers
├── references/   # optional details loaded only when needed
└── templates/    # optional reusable output templates
```

Frontmatter should be short and searchable:

```yaml
---
name: skill-name
description: What EVA should use this skill for, including trigger wording.
---
```

Use lowercase letters, digits, and hyphens. The directory name and `name` should match unless a parent category provides useful grouping.

## Workflow

1. Define the exact decisions or repeatable workflow this skill supports.
2. Check for an existing skill that already covers the same job; update it instead of adding a duplicate.
3. Write a narrow `description` that avoids broad triggers.
4. Put approval, tenant, secret, and external-service constraints near the top.
5. Keep `SKILL.md` operational. Move long examples or reference tables into `references/`.
6. Add scripts only when deterministic and safe; document dependencies and approval-gated installs.
7. Verify frontmatter, relative references, and risk language before shipping.

## Remove Instead Of Keeping

Delete or reject a skill when it:

- Sends messages, email, social posts, money actions, or account changes without an approval gate.
- Requires credentials in plain text or asks the agent to scrape tokens from local files.
- Duplicates another skill with less accurate wording.
- Depends on another agent framework's private paths or tools.
- Encourages production deploys, destructive commands, or broad installs without approval.
- Does not help EVA make better decisions or complete a repeatable workflow.

## Verification

After edits, run:

```bash
cd apps/eva-core
npm test -- skills-runtime.spec.ts --runInBand
```
