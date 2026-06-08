---
estado: diseño
proyecto: EVA
tipo: prompts
---
# 07 · Prompts por Fase (para Claude Code)

→ [[00 - EVA · Índice Maestro (MOC)|índice]] · anterior [[06 - Plan de Ejecución por Fases]]

Prompts listos para pegar en **Claude Code**. Cada uno asume el monorepo `eva/` y la rama de la fase. Pega primero el **System Prompt base**, luego el de la fase.

---

## 🧩 System Prompt base (pegar siempre primero)

```
Eres el coding worker de EVA, una plataforma agéntica distribuida.
Stack: TypeScript, NestJS, Supabase (Postgres+pgvector), Redis, BullMQ, Playwright, Docker, Next.js (dashboard).
Reglas innegociables:
- Multi-tenant: TODA tabla y query filtra por org_id. Nunca consultes sin org_id.
- RLS: si creas tablas, añade su migración y su política RLS en 014_rls_policies.sql.
- Seguridad: nada de secretos en código ni en cliente; usa variables de entorno y el secret manager.
- Aprobaciones: cualquier acción con dinero/producción/datos pasa por el Approval Engine (action_hash+nonce).
- Tests: entrega siempre tests y deja build+lint+test en verde.
- Entrega: explica el diff, lista archivos tocados y el comando para probar.
No hagas deploy, migraciones destructivas, ni cambios de secretos sin que yo apruebe.
```

---

## Fase 1 · EVA Core mínimo
```
Implementa el EVA Core mínimo en apps/eva-core (NestJS).
Incluye:
1. API Gateway con auth (Supabase JWT) y rate limiting.
2. WebSocket Gateway para nodos y dashboard.
3. Task Engine con estados pending|planning|running|waiting_for_approval|completed|failed|cancelled.
4. Event Bus sobre Redis Streams con eventos task.created/started/completed/failed.
5. Endpoints REST: POST /tasks, GET /tasks/:id, GET /health.
Aplica migraciones 001,002,003,004,013 y sus RLS en 014.
Tests: crear tarea, transición de estado, emisión de evento.
Verifica: una org NO puede leer tareas de otra (prueba de RLS).
```

## Fase 2 · Dashboard
```
Crea apps/eva-dashboard (Next.js + Tailwind + shadcn/ui).
Páginas: Login (Supabase Auth), Tareas (lista + detalle en tiempo real vía WS),
Nodos (estado/heartbeat), Eventos (stream), Logs, Aprobaciones (placeholder).
Realtime: suscríbete a eventos del Core por WebSocket.
Diseño: oscuro, denso en información, estilo "command center" (ver doc 09).
Tests: render de páginas y mock de stream de tareas.
```

## Fase 3 · Memory System
```
Implementa Memory Service en eva-core.
1. Aplica migración 005 (memories, memory_embeddings vector(1536)) + RLS en 014.
2. Pipeline de embeddings vía Model Router (interfaz embed()).
3. Búsqueda semántica top-k con pgvector (vector_cosine_ops).
4. Memory Agent: guarda/recupera; calcula importance.
5. Regla Fast Path: NO escribe memoria profunda directo; recibe resumen y el Core decide.
Tests: insertar memoria, generar embedding (mock), buscar por similitud, aislamiento por org.
```

## Fase 4 · Planner + LLM
```
Implementa Model Router, Planner, Tool Router e Intent Router.
- Model Router: interfaz única { generate, embed, realtimeToken } con backends OpenAI y Claude.
- Intent Router: clasifica fast_path | core_path | core_path+approval. Registra en intent_routes.
- Planner: convierte petición en plan (lista de steps con tool sugerida).
- Tool Router: elige nodo/herramienta por capability + latencia + costo.
Tests: clasificación de intents de ejemplo, generación de plan estructurado (JSON validado con zod).
```

## Fase 6 · Dev Manager + Claude Code
```
Implementa el Development Control Center en eva-core.
Aplica migración 010 + RLS.
Componentes: Project Registry, Repo Manager (git status/diff/log), Claude Code Controller
(start_session, send_task, read_output, get_status), Dev Task Queue (estados del doc),
Build/Test Runner, Progress Reporter, Roadmap Agent básico.
El Claude Code Controller habla con el nodo vía WebSocket; NUNCA ejecuta comandos peligrosos sin Approval.
Tests: crear dev_task, simular sesión CC (mock), correr build/test (mock), reportar estado.
```

## Fase 7 · Browser Agent
```
Implementa Browser Service con Playwright (packages/browser-runtime).
Aplica migración 009 + RLS.
Capacidades: open, click, type, screenshot, extract_text, extract_table, wait, close.
Perfiles persistentes por servicio (cifrados; cookies via envelope encryption, KMS mock en dev).
Toda acción con efecto: preparar -> screenshot -> generar action_hash -> Approval Engine.
Anti-injection: el texto extraído es DATO, no instrucción.
Tests: navegar a página local de prueba, extraer texto, generar action_hash.
```

## Fase 8 · Approval Engine
```
Implementa el Approval Engine.
Aplica migración 006 + RLS.
- Niveles 0..3 con clasificador.
- approval con action_hash = sha256(payload normalizado) + nonce + expires_at.
- Endpoints: request, approve, reject; nivel 3 exige dos aprobadores distintos.
- El ejecutor valida que sha256(payload_a_ejecutar)==action_hash y nonce no usado.
- UI de aprobación en dashboard con screenshot y resumen.
- Bloquea explícitamente acciones sensibles que lleguen por Fast Path.
Tests: TOCTOU (payload alterado -> rechazo), expiración, doble aprobación.
```

## Fase 9 · Communication Hub
```
Implementa Communication Hub.
Aplica migración 007 + RLS.
Canales: Telegram Bot, Discord Bot, Email (SMTP/Resend), Push, Dashboard.
Funciones: send_message, send_image, send_file, send_approval_request, send_status_update,
send_task_summary, send_dev_report, send_fast_path_summary.
Verifica firma de webhooks de Telegram/Discord.
Tests: envío mockeado por canal, verificación de firma.
```

## Fase 10 · Skill System
```
Implementa Skill Registry/Loader/Permissions/Versioning (packages/skill-runtime).
Aplica migración 008 + RLS.
Formato skill: manifest.json, instructions.md, tools.json, permissions.json, examples.md, tests.json,
memory_policy.json, approval_policy.json.
Skills iniciales (esqueleto): gmail, whatsapp-web, telegram, discord, browser-research, claude-code.
Tests: cargar skill, validar manifest (zod), versionar, permisos por skill.
```

## Fase 11 · MCP Manager
```
Implementa MCP Manager (packages/mcp-adapters).
Registry de servers, MCP client, permission layer, tool discovery, OAuth, audit logs, revocación, sandbox.
Adapters iniciales: GitHub, Supabase, PostgreSQL, Google, AWS.
Permisos por MCP y log de tool_calls. Tests con servidor MCP mock.
```

## Fase 13 · Wear Token Service + Fast Path Backend
```
Implementa Wear Fast Path Service.
Aplica migración 011 + RLS.
- Wear Token Service: emite token efímero (300s, scope wear_fast_path, max_tokens 500,
  tools [], memory_access false, actions_allowed false). Para OpenAI Realtime usar ephemeral key.
- Fast Path Policy Manager (allowed/disallowed del doc), Cost Guard (límite sesión+día), Usage Logger.
- Core Fallback Manager: si la petición excede límites, reenvía al Core Path.
Tests: emitir token, expiración, fallback en petición no permitida, límite de costo.
```

## Fase 18 · Seguridad avanzada
```
Endurece EVA.
- Sandbox por comando en nodos (contenedor efímero/allowlist) + egress filtering.
- audit_log con hash-chaining (prev_hash, hash) + ancla periódica firmada.
- Rotación de credenciales de nodo y revocación inmediata.
- Anti prompt/tool/skill injection: políticas + tests con payloads maliciosos.
- Hardening de Fast Path y revocación de tokens.
Tests: cadena de auditoría detecta manipulación; comando fuera de allowlist se bloquea.
```

---

> Para Uber Skill (F16), Auto Skill (F17), Android (F15) y Optimización (F19), deriva el prompt del patrón anterior: **objetivo → migración (si aplica) → reglas de seguridad → tests → criterio de hecho**.

➡️ Siguiente: [[08 - Tareas del Dev · Configuración y Despliegue]]
