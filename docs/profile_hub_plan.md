# EVA · Profile Hub Plan (Mi Perfil visual + privado unificado)

> Estado: **Fase 1 + split inicial implementados**. Plan detallado acordado el 2026-06-12;
> primera implementación agregada el 2026-06-12.
> Objetivo: sacar "Mi perfil" de `/soul` a una sección propia `/profile`, unificarla con el
> contexto privado (auto-ocultado), volverla visual (calendario, pendientes, metas, horarios,
> notas movibles) y que el sistema/agentes la llenen y lean vía estructuras de datos.

## Estado actual relevante
- `agent_souls`: persona agente + `persona_context` (personal_profile, cowork_context free-text,
  relationship_map) + `goals` JSONB + `private_context_ciphertext/hint` (AES-256-GCM write-only).
- `soul-editor.tsx`: ahora queda enfocado en identidad del agente; `/profile` carga el hub del usuario.
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
- Implementada: `profile_todos`, `profile_notes`, `profile_goals`, `profile_private_items`,
  `profile_suggestions`, `profile_private_access_logs`.
- `profile_goals` hace backfill desde `agent_souls.goals`.
- RLS inline en la propia migración (patrón real 021/027/031; AGENTS dice 014 pero 014 ya está aplicada).
- Grants de columna: `profile_private_items.ciphertext` jamás es legible por `authenticated`.
- Pendiente: migrar el blob legacy `agent_souls.private_context_ciphertext` a items `legacy` cuando se aplique en un entorno real.

## Endpoints (`/agent/profile`)
Implementado: `GET overview` · `POST facts` · `POST private-items` · `POST private-items/:id/reveal`
(auditado en `profile_private_access_logs`) · `POST suggestions/:id/accept|dismiss`.

Pendiente: `DELETE private-item`, rate-limit explicito, `POST migrate-legacy`.

## UI `/profile` (`components/profile/`)
Implementado: identity summary, stats, contexto operativo, relationship cards, pendientes, metas,
notas, agenda proxima y boveda privada con guardar/reveal cifrado.

Pendiente: completeness meter, week-calendar avanzado, drag reorder, dialogs, pintor semanal,
suggestion inbox visual, masking global "modo privado". No se agregaron deps nuevas en la primera pasada.

## Fases
1. **Datos+API**: hecho para migración 033, servicios, controller y unit tests. Falta RLS_TEST real.
2. **Split UI**: hecho para `/profile`, `/soul` podado y sidebar.
3. **Interacción**: pendiente drag notes/todos, dialogs eventos, pintor horarios, masking global.
4. **Auto-llenado**: pendiente digester v2, tools del loop, suggestion inbox, realtime, migrate-legacy.
5. **Prompt**: pendiente `ProfileContextBuilder` compartido, deprecación cowork_context, docs/evals.

## Riesgos
- Falsos positivos del clasificador → siempre reversible des-marcando (re-publica valor).
- Race posiciones notas → last-write-wins por campo.
- Crecimiento del bloque de contexto → prioridad + truncado por sección.
- Vault write-only actual → blob legacy convive hasta reescritura del usuario.
