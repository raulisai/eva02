# EVA — Roadmap de Inteligencia Exponencial

> Estado: propuesto · Fecha: 2026-06-12 · Base: commit posterior a "agnt sandbox improve"
> Principio rector: las mejoras lineales añaden features; las exponenciales construyen
> **ciclos compuestos** donde cada tarea ejecutada hace al sistema mejor en la siguiente.

## Por qué este orden

El sistema ya tiene el "cerebro por tarea" robusto (Fase 0). Lo que falta para el salto
exponencial son tres volantes de inercia (flywheels) que se alimentan entre sí:

```
  MEDIR ──────────► PENSAR MEJOR ──────────► APRENDER ENTRE TAREAS
 (Fase 1)            (Fase 2)                 (Fase 3)
    ▲                                              │
    └──────────── telemetría de cada mejora ◄──────┘
                          +
                AUTONOMÍA SEGURA (Fase 4, sobre límites duros)
```

Sin Fase 1, las Fases 2-4 son fe ciega. Cada fase cierra con un KPI verificable.

---

## Fase 0 — Hecho (baseline, 2026-06-12)

| Mejora | Dónde vive | Qué aporta |
|---|---|---|
| Tool-use nativo (Claude `tool_use` / OpenAI functions) con fallback JSON | `model-router.types.ts`, `model-router.service.ts`, `agent-loop.service.ts` (`buildToolDefinitions`, lectura de `res.toolCalls`) | Elimina la clase entera de errores de parseo |
| Detección de estancamiento semántico | `agent-loop.service.ts` `detectStall()` — ventana 4 pasos, firma tool+observación, 3 errores idénticos | Corta ciclos A→B→A que el loop-guard consecutivo no veía |
| Definition-of-done | `agent-loop.service.ts` `validateFinalAnswer()` — máx 2 rechazos, respeta reportes honestos de fallo | El agente no puede declarar éxito con el último código fallido |
| Skill quarantine + promoción | `skill-library.service.ts` — `status: 'provisional'`, penalización −1.5 en score, `maybePromoteProvisional()` con ≥2 éxitos | La auto-sedimentación deja de contaminar el catálogo |
| Infra ya disponible para fases siguientes | `scheduled_jobs` (022) + `jobs/`, `token_logs` (023/025), `skill_usage_stats`/`skill_graph_edges` (027), `memories`+`memory_embeddings` (005), Approval Engine (013) | No hay que construir cimientos nuevos |

Tests: 472/472 verdes, incluidos 6 nuevos para A-D.

---

## Fase 1 — Medir (el multiplicador de todo lo demás)

**Meta: ningún cambio de prompt/lógica vuelve a evaluarse "a ojo".**

### 1.1 Persistencia de trayectorias (E) — esfuerzo M
- Migración `028_agent_trajectories.sql`: tabla `agent_trajectories`
  (`org_id`, `task_id`, `goal`, `steps jsonb`, `outcome` (ok/failed/degraded/cancelled),
  `tokens_used`, `tools_used text[]`, `depth`, `duration_ms`, `stall_count`,
  `dod_rejections`, `model_budget_per_step jsonb`, `created_at`).
  RLS: política en `014_rls_policies.sql` según regla del proyecto.
- Hook: al final de `run()` en `agent-loop.service.ts`, fire-and-forget como
  `recordSkillOutcome` (nunca rompe el loop). Contadores de stall/DoD ya existen
  como variables locales — solo hay que exportarlos.
- **Doble función**: es también el sustrato del checkpoint/resume (4.4) y del
  replay few-shot (3.4).

### 1.2 Telemetría agregada — esfuerzo S
- Vistas SQL sobre `agent_trajectories` + `skill_usage_stats` + `token_logs`:
  - tasa de éxito por herramienta y por tipo de objetivo
  - frecuencia de stalls y de rechazos DoD (¿las defensas nuevas disparan? ¿demasiado?)
  - funnel de skills: registradas → provisionales → promovidas → reusadas
  - pasos y tokens promedio por tarea
- Endpoint `GET /agent/metrics` (org-scoped, mismo patrón que health/tasks).

### 1.3 Eval harness con golden tasks — esfuerzo M ★ la pieza más importante del roadmap
- `apps/eva-core/evals/golden-tasks.json`: 20-30 objetivos reales con verificador
  programático cada uno (predicado sobre el texto final, herramientas esperadas,
  máximo de pasos). Ej.: "calcula X con código" → final contiene el número correcto
  y usó `code_execute`.
- `scripts/agent-evals.ts` (espejo de `sandbox-smoke.ts`): corre el loop con tools
  mockeados deterministas (modo CI) o reales (modo smoke). Reporta: pass-rate,
  pasos promedio, tokens promedio, regresiones vs. último run.
- Regla de proceso: **ninguna fase posterior se mergea si baja el pass-rate**.

**KPI de fase**: baseline de pass-rate establecido y visible; stall-rate y
DoD-rejection-rate medidos por primera vez.

---

## Fase 2 — Pensar mejor dentro de la tarea

**Meta: subir el pass-rate en tareas multi-paso y bajar tokens por tarea.**

### 2.1 Plan-como-estado (G) — esfuerzo M ★ mayor mejora de inteligencia percibida
- El plan deja de ser decorativo: para tier=long, el primer paso del loop genera
  (modelo cheap) un checklist de 3-6 subpasos que vive en el estado del run.
- Se renderiza en el **user prompt** de cada decide (no en el system — preserva el
  prefijo cacheable): `PLAN: [✓] paso1 [→] paso2 [ ] paso3`.
- El loop marca subpasos automáticamente cuando una observación exitosa los cubre
  (match léxico barato) y el modelo puede corregir el plan con una herramienta
  interna `plan_update`.
- **Replan en stall**: si `detectStall` dispara 2 veces, se regenera el plan
  incorporando lo aprendido (los errores vistos). Patrón "recitation" de
  Manus/Claude Code: re-citar el plan cada turno ancla la atención del modelo.

### 2.2 Escalación adaptativa de modelo — esfuerzo S ★ mejor ratio costo/beneficio
- El decide arranca con budget `cheap`; escala a `balanced` tras el primer
  ERROR/stall/rechazo-DoD del run; a `powerful` si el stall persiste tras replan.
- Se registra qué budget produjo cada decisión (va al `model_budget_per_step` de
  1.1) → la telemetría dirá qué % de decisiones resuelve el modelo barato
  (hipótesis: >70%).
- Análogo: si el quick-path del runner falla, auto-promover a long en vez de
  fallar (hoy `tier.ts` es regex one-shot).

### 2.3 Tool-calls paralelos — esfuerzo S
- El tool-use nativo ya devuelve N llamadas; el loop hoy lee solo la primera.
- Ejecutar concurrentemente **solo herramientas read-only** (allowlist:
  `web_search`, `gmail_read`, `calendar_read`, `drive_read`, `memory_recall`,
  `sandbox_ls`); las de efectos (código, telegram, skills) siguen serializadas
  — evita carreras sobre `/work`.
- Una observación por llamada, todas entran como pasos del mismo ciclo.

### 2.4 Herramienta `ask_user` + estado `waiting_for_input` — esfuerzo M
- Espejo de `waiting_for_approval` en la máquina de estados (migración pequeña +
  actualización del diagrama en CLAUDE.md).
- Tool `ask_user{"question","options"?}`: envía la pregunta por el canal activo
  (TelegramAdapter ya inyectado en el loop), pausa la tarea; la respuesta del
  usuario entra como observación y el loop continúa.
- Timeout 15 min → continúa con "sin respuesta del usuario; asume lo razonable y
  decláralo en el final_answer".
- Convierte tareas que hoy fallan por ambigüedad en tareas que se pausan 2 minutos.

### 2.5 Compresión semántica del historial — esfuerzo S
- Hoy los pasos viejos se truncan a 160 chars (pierde la cola, donde suele estar
  el error). Cambio: cuando el historial supere un umbral, resumir los pasos
  viejos con modelo cheap en una línea factual cada uno; los pasos ERROR se
  conservan textuales (son los que enseñan).

**KPI de fase**: pass-rate de golden tasks multi-paso +X pts; tokens/tarea −20%
esperado por escalación adaptativa; % de stalls resueltos tras replan.

---

## Fase 3 — Aprender entre tareas (el volante exponencial propiamente)

**Meta: cada tarea exitosa deja capacidad reutilizable; cada fallida deja una lección.**

### 3.1 pgvector para skills + dedupe en registro — esfuerzo M
- Embeber `slug + description` al registrar (modelo `text-embedding-3-small` ya
  está en `EMBED_MODELS`); tabla/columna `skill_embeddings` análoga a
  `memory_embeddings`.
- `findRelevant` = híbrido: coseno (recall semántico, resuelve sinónimos tipo
  "baja el video" ≠ "descargar youtube") + señales existentes (stats, grafo,
  concurrencia) para el ranking.
- **Dedupe**: si una skill nueva tiene similitud >0.92 con una existente,
  versionar la existente en vez de crear fila nueva — ataca la proliferación
  de skills casi idénticas que la quarantine sola no evita.

### 3.2 Consolidación de memoria nocturna (F) — esfuerzo M
- Job en `scheduled_jobs` (infra ya existe): por org,
  1) dedupe de memorias con coseno >0.95 (conservar la más reciente),
  2) decay: sin recall en 60 días e importancia baja → archivar,
  3) clustering de memorias procedurales similares → resumir en "playbooks"
     de mayor nivel (modelo cheap).
- Sin esto, el recall se degrada con el volumen: cada solución memorizada
  compite contra las anteriores.

### 3.3 Replay de trayectorias como few-shot — esfuerzo M ★ el compounding más directo
- Al iniciar un run raíz: embeber el goal, buscar la trayectoria **exitosa** más
  similar en `agent_trajectories` (requiere 1.1), e inyectar una versión compacta
  ("EJEMPLO DE RESOLUCIÓN PREVIA: pasos que funcionaron para un objetivo similar")
  en el contexto del primer decide.
- Es el patrón Voyager: los éxitos pasados enseñan a los runs futuros sin
  fine-tuning. Con 2.2, además permite que el modelo cheap resuelva tareas que
  antes necesitaban el caro, porque va guiado.

### 3.4 Self-improvement batch (pilar Hermes) — esfuerzo L
- Job semanal: lee trayectorias fallidas, clustering de patrones de fallo con
  modelo cheap ("gmail_read falla con queries acentuados", "yt-dlp falla en
  playlists"), genera:
  1) reporte digest por Telegram al owner del org,
  2) skills correctivas propuestas **como provisionales** (la quarantine de
     Fase 0 es exactamente la red de seguridad para esto).
- Humano en el loop siempre: nada se promueve sin los ≥2 éxitos reales.

**KPI de fase**: tasa de reúso de skills ↑, pasos promedio en tareas de clase
repetida ↓ (el sistema "ya sabe" cómo resolverlas), precisión del recall ↑.

---

## Fase 4 — Autonomía segura (en este orden estricto)

**Meta: EVA propone y actúa sola, con presupuesto de error acotado.**

### 4.1 Límites duros PRIMERO — esfuerzo S
- Spend cap de tokens por tarea (kill switch leyendo `token_logs`, que ya tiene
  `task_id`): al superar el cap, el loop cierra con final_answer honesto.
- Rate limit por herramienta por org (Redis, infra ya presente).
- Allowlist de dominios para ejecuciones sandbox con red (complementa el approval
  `sandbox.network_exec` existente).

### 4.2 Enforcement de revisión de seguridad — esfuerzo S
- Hoy "valida con seguridad antes del final_answer" es una sugerencia en el prompt.
- Cambio: si algún paso del run tocó secrets (`§§secret`), red, o herramientas
  sensibles, el loop **fuerza** un pase por el sub-agente `seguridad` antes de
  aceptar el final_answer (gate a nivel de código, análogo al DoD).

### 4.3 Heartbeat proactivo (pilar Crons de Hermes / HEARTBEAT.md de OpenClaw) — esfuerzo M
- Job diario por org sobre `scheduled_jobs`: corre el loop con objetivo plantilla
  ("revisa correo, agenda y pendientes; si hay algo accionable, propón 1-3
  acciones concretas") y entrega el brief por Telegram.
- Todas las acciones propuestas son read-only o pasan por Approval Engine.
- Es la feature que más cambia la percepción de "asistente" a "agente". La
  infraestructura completa ya existe — es mayormente orquestación.

### 4.4 Checkpoint/resume de loops — esfuerzo M
- Persistir steps incrementalmente en `agent_trajectories` (1.1) en cada
  iteración, no solo al final.
- Al arrancar el servicio: tareas en estado no-terminal con trayectoria a medias
  → reanudar desde el último paso en vez de perder todo el progreso.

**KPI de fase**: cero incidentes de gasto desbocado; % de briefs del heartbeat
sobre los que el usuario actúa.

---

## Dependencias y secuencia

```
1.1 trayectorias ──┬─► 2.1 replan (telemetría de stalls)
                   ├─► 3.3 replay few-shot
                   ├─► 3.4 self-improvement
                   └─► 4.4 checkpoint/resume
1.3 evals ─────────► gate de TODAS las fases (no-regresión)
4.1 límites ───────► prerrequisito de 4.3 heartbeat
3.1 pgvector skills ─► potencia 3.4 (dedupe de skills propuestas)
```

Estimación gruesa: Fase 1 ≈ 1 semana · Fase 2 ≈ 2 semanas · Fase 3 ≈ 2 semanas ·
Fase 4 ≈ 1 semana. Cada item es mergeable por separado.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Plan-como-estado rompe el prompt caching | El plan va en el **user prompt** (dinámico); el system permanece idéntico entre pasos |
| Tool-calls paralelos corrompen `/work` | Solo se paraleliza la allowlist read-only |
| Costo de embeddings de skills | Embeber solo en register/update (no en cada findRelevant); cachear |
| `waiting_for_input` complica la máquina de estados | Es espejo exacto de `waiting_for_approval`, ya probado |
| Self-improvement genera skills basura | Nacen provisionales (quarantine Fase 0) + digest humano |
| Heartbeat se vuelve spam | Cap de 1 brief/día, umbral de accionabilidad, opt-out por org |

## Reglas no negociables (heredan de CLAUDE.md)

- Toda tabla nueva: filtro `org_id` en cada query + migración + política RLS en `014_rls_policies.sql`.
- Acciones con dinero/producción/datos → Approval Engine.
- Cada item se entrega con tests; build+lint+test verdes.
- Nada de migraciones destructivas ni cambios de secrets sin aprobación explícita.
