# EVA · Profile Hub Plan (Mi Perfil visual + privado unificado)

> Estado: **planeado** (sin código aún). Plan detallado acordado el 2026-06-12.
> Objetivo: sacar "Mi perfil" de `/soul` a una sección propia `/profile`, unificarla con el
> contexto privado (auto-ocultado), volverla visual (calendario, pendientes, metas, horarios,
> notas movibles) y que el sistema/agentes la llenen y lean vía estructuras de datos.

## Estado actual relevante
- `agent_souls`: persona agente + `persona_context` (personal_profile, cowork_context free-text,
  relationship_map) + `goals` JSONB + `private_context_ciphertext/hint` (AES-256-GCM write-only).
- `soul-editor.tsx`: tabs Agente / Mi perfil / Privado — todo inputs/textarea de texto libre.
- Ya existen SIN UI: `schedule_events`, `known_places`, `behavior_patterns` (021) +
  `ScheduleService`/`BehaviorPatternService` (solo alimentan prompts).
- `ConversationDigesterService.maybeUpdateSoulProfile`: auto-fill por regex (occupation/location).
- `agent-runner.formatEnrichedSoulContext`: arma bloque soul+schedule+patterns+privado (5000 chars).

## Decisiones
| # | Decisión | Razón |
|---|----------|-------|
| D1 | `/soul` queda solo agente; nueva ruta `/profile` para el usuario | separación identidad agente vs usuario |
| D2 | Texto libre → tablas: `profile_todos`, `profile_notes` (posición JSONB), `profile_goals` (backfill desde `agent_souls.goals`); schedule reusa `schedule_events`; horarios → `persona_context.schedule_prefs` estructurado | escrituras concurrentes agente+usuario sin races, RLS por fila, realtime, queries por fecha/estado |
| D3 | Sensibilidad por item (`normal\|personal\|sensitive`) + `SensitivityClassifierService` (regex + modelo cheap opcional); sensitive → cifrado en vault estructurado (`private_items`), en tabla solo hint enmascarado; UI inline con blur/candado + reveal server-side auditado; desaparece tab Privado | unifica privado con perfil; auto-hide pedido por usuario |
| D4 | Digester v2: extracción estructurada (modelo cheap → JSON facts con confidence); `ProfileFactsService` aplica (nunca pisa datos del usuario; baja confianza → suggestion inbox); tools nuevas del loop: `profile_update`, `todo_manage`, `goal_manage`, `note_add`, `schedule_event_manage`; realtime en dashboard | el sistema llena el perfil igual que el usuario |
| D5 | Extraer armado de contexto a `ProfileContextBuilder` compartido (runner+loop) con budget por sección; legacy `cowork_context` se lee hasta migrar, luego se depreca | integración real del perfil en prompts |
| D6 | API mixta: tablas planas → Supabase RLS directo + realtime (patrón soul-editor); cifrado/sugerencias/migración → `ProfileController` en eva-core | menos backend, realtime gratis, secreto nunca toca el cliente |

## Migración `033_profile_hub.sql`
- `profile_todos(id, org_id, title, notes, status, due_date, priority, sensitivity, source, confidence, evidence_task_id, hint, created_at, updated_at)`
- `profile_notes(id, org_id, title, content, color, pinned, position JSONB, sensitivity, source, hint, agent_visible, ...)`
- `profile_goals(...)` + backfill desde `agent_souls.goals`
- `agent_souls.private_context_ciphertext` evoluciona a JSON cifrado de items (blob actual = item `legacy`)
- RLS inline en la propia migración (patrón real 021/027/031; CLAUDE.md dice 014 pero 014 ya está aplicada — convención documentada aquí)
- Grants de columna: ciphertext jamás legible por `authenticated` (igual que 031)

## Endpoints (`/agent/profile`)
`GET overview` (SSR agregado) · `POST/DELETE private-item` · `POST private-item/reveal` (audit+rate-limit)
· `POST migrate-legacy` (one-shot: cowork_context texto → sugerencias estructuradas vía modelo)
· `POST suggestions/:id/accept|dismiss`

## UI `/profile` (`components/profile/`)
identity-card + completeness-meter · week-calendar (tira 14 días scrollable, date-fns + CSS grid, sin lib calendario; badges de source) · todo-board (drag reorder) · goal-cards (barras progreso) · notes-board (notas movibles, posición persistida, badge Bot) · schedule-prefs-grid (pintor semanal) · relationship-cards · suggestion-inbox · masking global "modo privado".
Deps nuevas: `@dnd-kit/core`, `@dnd-kit/sortable`, `@radix-ui/react-dialog`, `react-popover`, `react-checkbox`.

## Fases
1. **Datos+API**: migración 033, servicios (`SensitivityClassifier`, `ProfileFactsService`), `ProfileController`, tests RLS.
2. **Split UI**: `/profile` read-only visual, `/soul` podado, sidebar.
3. **Interacción**: drag notes/todos, dialogs eventos, pintor horarios, vault unificado masking/reveal.
4. **Auto-llenado**: digester v2, tools del loop, suggestion inbox, realtime, migrate-legacy.
5. **Prompt**: `ProfileContextBuilder` compartido, deprecación cowork_context, docs/evals.

## Riesgos
- Falsos positivos del clasificador → siempre reversible des-marcando (re-publica valor).
- Race posiciones notas → last-write-wins por campo.
- Crecimiento del bloque de contexto → prioridad + truncado por sección.
- Vault write-only actual → blob legacy convive hasta reescritura del usuario.
