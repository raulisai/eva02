---
name: requesting-code-review
description: Run a pre-commit quality and security review of EVA changes before committing, pushing, or calling work complete.
---

## EVA Runtime Safety

Follow the EVA Runtime Skill Policy in `apps/eva-core/src/skills/RUNTIME_SKILL_POLICY.md`. This skill reviews and verifies; it does not push, merge, deploy, or mutate external systems without approval.

# Requesting Code Review

Use this after implementation and before delivery.

## Checklist

1. Inspect `git status --short` and the relevant diff.
2. Look for secrets, debug code, broad exception swallowing, unsafe shell execution, and dependency churn.
3. Check EVA invariants:
   - tenant data is scoped by `org_id`
   - RLS changes live in `014_rls_policies.sql`
   - sensitive actions use Approval Engine
   - public/private route boundaries remain correct
4. Run focused tests first, then broader tests when the blast radius is larger.
5. Summarize findings, fixes made, residual risk, and verification commands.

## Recommended Commands

```bash
git status --short
git diff --stat
git diff
npm test
npm run test:e2e
```

Use `RLS_TEST=true npm run test:e2e` when RLS behavior changed and real Supabase test credentials are configured.
