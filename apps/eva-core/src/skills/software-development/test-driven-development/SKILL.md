---
name: test-driven-development
description: Use red-green-refactor for EVA feature work, bug fixes, refactors, and behavior changes.
---

## EVA Runtime Safety

Follow the EVA Runtime Skill Policy in `apps/eva-core/src/skills/RUNTIME_SKILL_POLICY.md`. Tests must not use real tenant data, secrets, or production services.

# Test-Driven Development

Use this when changing behavior.

## Loop

1. Write the smallest failing test that captures the desired behavior or bug.
2. Run it and confirm it fails for the expected reason.
3. Implement the minimal fix.
4. Run the focused test until it passes.
5. Refactor while keeping tests green.
6. Run broader tests when shared modules, auth, RLS, or task state transitions are touched.

## EVA Test Targets

- Unit tests for services, repositories, guards, and state-machine behavior.
- E2E tests for API flows and mocked DB behavior.
- `RLS_TEST=true npm run test:e2e` for real RLS changes when configured.

## Rule Of Thumb

If the change can affect tenant isolation, approvals, secrets, task state, or public/private route behavior, add a test.
