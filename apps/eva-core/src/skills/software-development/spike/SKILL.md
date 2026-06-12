---
name: spike
description: Design a small, disposable experiment to validate a risky EVA implementation idea before committing to production code.
---

## EVA Runtime Safety

Follow the EVA Runtime Skill Policy in `apps/eva-core/src/skills/RUNTIME_SKILL_POLICY.md`. Spikes must stay local and disposable unless the user approves external services, installs, data changes, or production access.

# Spike

Use this when an idea has meaningful uncertainty that reading code or docs will not resolve.

## Method

1. State the hypothesis and the risk it validates.
2. Define a small observable result.
3. Prefer local fixtures or mocked data.
4. Avoid changing production code paths unless the user explicitly approves.
5. Record the result: keep, reject, or investigate further.
6. Delete or isolate throwaway code after the verdict.

## EVA Guardrails

- Do not use real tenant data.
- Do not bypass RLS or auth for convenience.
- Do not introduce dependencies unless approved.
- Convert any useful result into tested production code before shipping.
