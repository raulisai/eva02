---
name: plan
description: Create an actionable implementation plan for EVA work without making code, data, production, or external-account changes.
---

## EVA Runtime Safety

Follow the EVA Runtime Skill Policy in `apps/eva-core/src/skills/RUNTIME_SKILL_POLICY.md`. Planning is read-only unless the user explicitly asks to save a plan file.

# Plan

Use this skill when the user asks for a plan, wants options before implementation, or the task is broad enough that execution would be risky without alignment.

## Output

Produce a concise markdown plan with:

- Goal
- Current context and assumptions
- Proposed approach
- Step-by-step implementation tasks
- Files likely to change
- Tests and verification commands
- Risks, tradeoffs, and open questions

## EVA Checks To Include

- Where `org_id` boundaries apply.
- Whether migrations or `014_rls_policies.sql` are needed.
- Whether the Approval Engine is required.
- Which unit/e2e tests should prove the behavior.
- Whether any external service, install, production action, or secret change needs approval.

## Behavior

- Inspect local context with read-only commands if useful.
- Do not implement while using this skill.
- Ask a brief clarifying question only when a safe plan cannot be written from available context.
