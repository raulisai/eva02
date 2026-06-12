---
name: systematic-debugging
description: Debug EVA issues by reproducing the failure, finding root cause, fixing narrowly, and proving the fix with tests.
---

## EVA Runtime Safety

Follow the EVA Runtime Skill Policy in `apps/eva-core/src/skills/RUNTIME_SKILL_POLICY.md`. Debugging production, tenant data, secrets, or destructive state requires explicit approval.

# Systematic Debugging

Use this for test failures, build failures, runtime errors, performance regressions, and confusing behavior.

## Process

1. Read the exact error and relevant logs.
2. Reproduce the issue with the smallest command or test.
3. Identify the root cause in code or configuration.
4. Write or update a failing test when behavior should be protected.
5. Apply the smallest fix that addresses the root cause.
6. Run the focused test, then broader verification if the change touches shared behavior.

## EVA Checks

- Confirm tenant boundaries when the bug touches data access.
- Check RLS and auth behavior separately from service logic.
- Preserve the task state machine.
- Do not paper over approval failures by bypassing the Approval Engine.
