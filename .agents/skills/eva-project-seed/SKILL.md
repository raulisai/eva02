---
name: eva-project-seed
description: Compact project seed for the EVA monorepo. Use before any task that changes, reviews, tests, explains, or plans work in /Users/djoker/code/eva02, especially eva-core NestJS, Supabase migrations/RLS, Next dashboard, runtime skills, tasks/events/approvals/agent/memory/browser/wear/jobs/dev-control. Read the seed references first to avoid broad code rediscovery, and after every use update the seed with a compact change record plus a mandatory pending/improvement note.
---

# EVA Project Seed

## Prime Directive

Use this skill as EVA's compact project memory. Start from the seed, read only the code needed for the current change, and leave the seed better than you found it.

Every use must end with a seed update:

- Update `references/project-map.md` when architecture, module ownership, APIs, schema, commands, or invariants changed.
- Always append a compact entry to `references/change-log.md`.
- Always leave one non-empty pending/improvement/risk/test-gap note. Never write "none".
- Never store secrets, tokens, private URLs, customer data, or env values in this skill.

## Workflow

1. Read `references/project-map.md` and [architecture.md](file:///Users/djoker/code/eva02/docs/architecture.md).
2. Read the top of `references/change-log.md` and [backlog.md](file:///Users/djoker/code/eva02/docs/backlog.md) for recent changes, pending tasks, and technical debts.
3. Check `git status --short` and preserve unrelated user changes.
4. Select any other relevant skill only after this seed is loaded (e.g., NestJS, Supabase, Playwright).
5. Inspect only the files needed to verify the seed or implement the request.
6. Implement code changes following established patterns, keeping tenancy/RLS/approval/test rules intact.
7. Verify changes with tests and commands.
8. Update the living documentation (under `docs/`) and the backlog ([backlog.md](file:///Users/djoker/code/eva02/docs/backlog.md)) if architecture, layouts, behaviors, or tasks changed, adhering to the [improvement_loop.md](file:///Users/djoker/code/eva02/docs/improvement_loop.md) rules.
9. Update this seed (project map and change log) before presenting the final answer.

## Mandatory Seed & Doc Update

Preferred append command to update the seed:

```bash
python3 .agents/skills/eva-project-seed/scripts/update_seed.py \
  --change "area: compact description of what changed" \
  --files "path/a.ts,path/b.sql" \
  --tests "npm test" \
  --pending "next improvement, risk, or test gap"
```

If the script is unavailable, manually append the same format to `references/change-log.md`:

```text
### YYYY-MM-DD HH:MMZ
C: area -> compact change; files=...; tests=...
P: pending/improve -> ...
```

In addition, ensure [backlog.md](file:///Users/djoker/code/eva02/docs/backlog.md) and relevant files under `docs/` are updated accordingly.

## Read-Code Budget

Do not re-scan the whole project by default. Use the seed and `docs/` as the map, then read:

- The target files requested by the user.
- Adjacent tests and DTO/types for changed behavior.
- The exact migration/RLS files when touching schema.
- The exact dashboard component/API client when changing UI behavior.

If the seed conflicts with code, trust code, fix the seed, and note the drift in `change-log.md`.
