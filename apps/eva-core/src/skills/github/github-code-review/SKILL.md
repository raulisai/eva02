---
name: github-code-review
description: Review local git diffs or GitHub PR diffs for bugs, security issues, tenant isolation regressions, missing tests, and unsafe changes.
---

## EVA Runtime Safety

Follow the EVA Runtime Skill Policy in `apps/eva-core/src/skills/RUNTIME_SKILL_POLICY.md`. Prefer read-only review. Posting comments, approving PRs, pushing, merging, or using GitHub credentials requires explicit approval.

# GitHub Code Review

Use this skill for review-oriented work only. Findings should lead, ordered by severity, with file and line references when available.

## Review Scope

- Local changes: `git diff`, `git diff --staged`, or a user-specified commit range.
- PR diffs: inspect with `gh pr diff <number>` only when GitHub access is already configured.
- Do not scrape tokens from dotfiles or credential stores. If auth is missing, ask for a safe configured path or review local diffs instead.

## EVA-Specific Checks

- Every table/query touching tenant data filters by `org_id`.
- New tables have migrations and RLS policy updates in `014_rls_policies.sql`.
- Secrets are not committed and are not exposed to client code.
- Money, production, destructive, and tenant-data actions go through the Approval Engine.
- Task state transitions match the EVA state machine.
- Unit/e2e coverage matches the risk of the change.

## Process

1. Identify the diff range and changed files.
2. Read enough surrounding code to understand behavior, not just the patch.
3. Check security, tenant isolation, error handling, tests, and backward compatibility.
4. Report findings first. Use concise severity labels such as `[P0]`, `[P1]`, `[P2]`.
5. If there are no findings, say that clearly and name any residual test gaps.

## Safe Commands

```bash
git status --short
git diff --stat
git diff --staged
git diff main...HEAD --stat
git diff main...HEAD --name-only
```
