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

1. Read `references/project-map.md`.
2. Read the top of `references/change-log.md` for recent deltas and pending notes.
3. Check `git status --short` and preserve unrelated user changes.
4. Select any other relevant skill only after this seed is loaded, for example NestJS, Supabase, Next.js, frontend design, Playwright, or Zod.
5. Inspect only the files needed to verify the seed or implement the request.
6. Make the change with the repo's existing patterns, keeping tenant/RLS/approval/test rules intact.
7. Verify with the narrowest meaningful command, then broader commands when risk warrants it.
8. Update this seed before the final answer.

## Mandatory Seed Update

Preferred append command:

```bash
python3 .agents/skills/eva-project-seed/scripts/update_seed.py \
  --change "area: compact description of what changed" \
  --files "path/a.ts,path/b.sql" \
  --tests "npm test -- --runInBand file.spec.ts" \
  --pending "next improvement, risk, TODO, doc drift, or test gap"
```

If the script is unavailable, manually append the same format to `references/change-log.md`:

```text
### YYYY-MM-DD HH:MMZ
C: area -> compact change; files=...; tests=...
P: pending/improve -> ...
```

Keep entries terse and optimized for another AI agent. Prefer stable nouns, exact paths, table names, route names, and commands over prose.

## Read-Code Budget

Do not re-scan the whole project by default. Use the seed as the map, then read:

- The target files requested by the user.
- Adjacent tests and DTO/types for changed behavior.
- The exact migration/RLS files when touching schema.
- The exact dashboard component/API client when changing UI behavior.

If the seed conflicts with code, trust code, fix the seed, and note the drift in `change-log.md`.
