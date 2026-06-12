# EVA Seed Change Log

Newest first. Every use of `$eva-project-seed` must add one `C:` and one `P:` entry. Keep it compact and exact.

### 2026-06-12 00:00Z
C: seed -> created `eva-project-seed` skill with project map, mandatory update protocol, and update script; files=.agents/skills/eva-project-seed/*; tests=quick_validate pending
P: reconcile docs/schema drift -> AGENTS/README say migrations through 015 and RLS only in 014, but repo has 001-027 and later policy migrations; also verify `task_steps` reference and `tasks.findStuck` org scope.
