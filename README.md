# EVA — Agentic Platform

EVA es una plataforma agéntica distribuida diseñada para funcionar como asistente personal inteligente, orquestador de tareas, operador de navegador, sistema de memoria semántica y centro de desarrollo de software.

```
EVA Cloud Core  →  cerebro central, agentes, memoria, skills, MCP, tareas, aprobaciones
EVA Nodes       →  Mac · Windows · Linux · Android · Wear OS · servidores
EVA Interfaces  →  Galaxy Watch · Dashboard · Telegram · Discord · Email · Voz
EVA Fast Path   →  ruta rápida con token efímero desde Wear OS
```

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Backend | TypeScript · NestJS |
| Base de datos | Supabase Postgres + pgvector |
| Cache / Queue | Redis · BullMQ · Redis Streams |
| Browser | Playwright (perfiles persistentes) |
| Auth | Supabase Auth (JWT + claim `org_id`) |
| Dashboard | Next.js 14 · Tailwind · shadcn/ui |
| Realtime | WebSocket (Socket.io) + Supabase Realtime |
| Reloj | Kotlin · Jetpack Compose for Wear OS |
| Contenedores | Docker · Docker Compose |

---

## Estructura del repositorio

```
eva02/
├── apps/
│   ├── eva-core/        # NestJS API — backend principal
│   └── eva-dashboard/   # Next.js 14 — panel de control
├── supabase/
│   └── migrations/      # Migraciones SQL (aplicar en orden numérico)
├── docker/
│   └── postgres-init.sql
├── docker-compose.yml
└── doc/                 # Documentación de arquitectura y fases
```

---

## Requisitos previos

- Node.js 20+
- Docker + Docker Compose
- Cuenta en [Supabase](https://supabase.com) (o instancia local)
- Redis 7+ (incluido en Docker Compose)

---

## Inicio rápido

### 1. Clonar y preparar variables de entorno

```bash
# Variables raíz (Docker Compose)
cp .env.example .env

# Backend
cp apps/eva-core/.env.example apps/eva-core/.env

# Dashboard
cp apps/eva-dashboard/.env.example apps/eva-dashboard/.env
```

Editar cada archivo con los valores reales (ver sección [Variables de entorno](#variables-de-entorno)).

### 2. Levantar infraestructura local

```bash
# Postgres + Redis
docker compose up -d postgres redis
```

### 3. Aplicar migraciones a Supabase

Pega cada archivo **en orden** en Supabase Studio → SQL Editor → Run, o usa la CLI:

```bash
supabase db push
```

Orden obligatorio:

```
001_extensions.sql
002_orgs_users.sql
003_tasks.sql
004_events.sql
013_approvals.sql
014_rls_policies.sql
```

> **Nunca** saltes el orden ni ejecutes migraciones destructivas sin aprobación explícita.

### 4. Instalar dependencias

```bash
# Desde la raíz del monorepo
npm install

# O individualmente
cd apps/eva-core && npm install
cd apps/eva-dashboard && npm install
```

### 5. Arrancar en desarrollo

```bash
# Backend (puerto 3000)
cd apps/eva-core
npm run start:dev

# Dashboard (puerto 3001) — en otra terminal
cd apps/eva-dashboard
npm run dev
```

### 6. Usando Docker Compose completo

```bash
docker compose up -d
```

Esto levanta Postgres, Redis y eva-core juntos. El dashboard corre fuera de Docker en desarrollo.

---

## Variables de entorno

### `apps/eva-core/.env`

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `SUPABASE_URL` | URL del proyecto Supabase | `https://<project>.supabase.co` |
| `SUPABASE_ANON_KEY` | Clave anon pública | `eyJ...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave service role (solo backend) | `eyJ...` |
| `SUPABASE_JWT_SECRET` | Secret JWT de Supabase (Settings → API) | `super-secret-jwt-...` |
| `DATABASE_URL` | Conexión directa Postgres | `postgresql://postgres:<pwd>@<host>:5432/postgres` |
| `REDIS_URL` | URL de Redis | `redis://localhost:6379` |
| `PORT` | Puerto del servidor | `3000` |
| `NODE_ENV` | Entorno | `development` |
| `THROTTLE_TTL` | Ventana de rate limit en segundos | `60` |
| `THROTTLE_LIMIT` | Max requests por ventana | `100` |
| `CORS_ORIGIN` | Origen permitido en CORS | `http://localhost:3001` |

> `SUPABASE_SERVICE_ROLE_KEY` **nunca** debe exponerse al cliente ni commitearse.

### `apps/eva-dashboard/.env`

| Variable | Descripción |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | URL pública del proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave anon pública |
| `NEXT_PUBLIC_EVA_CORE_URL` | URL del backend (ej. `http://localhost:3000`) |
| `EVA_CORE_URL` | URL interna server-side del backend |

### `.env` raíz (Docker Compose)

| Variable | Descripción |
|----------|-------------|
| `POSTGRES_PASSWORD` | Password de Postgres local |

---

## Cómo obtener las claves de Supabase

1. Ve a [app.supabase.com](https://app.supabase.com) → tu proyecto.
2. **Settings → API**:
   - `URL` → `SUPABASE_URL`
   - `anon public` → `SUPABASE_ANON_KEY`
   - `service_role` → `SUPABASE_SERVICE_ROLE_KEY` *(solo backend)*
   - `JWT Secret` → `SUPABASE_JWT_SECRET`
3. **Settings → Database** → Connection string → `DATABASE_URL`

---

## API REST

Base URL: `http://localhost:3000`

### Autenticación

Todos los endpoints (excepto `/health`) requieren:

```
Authorization: Bearer <supabase-jwt>
```

Si el JWT no incluye `org_id` en `app_metadata`, se puede pasar el header:

```
X-Org-Id: <uuid-de-tu-org>
```

### Endpoints principales

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/health` | Health check público |
| `POST` | `/tasks` | Crear una tarea |
| `GET` | `/tasks/:id` | Obtener tarea por ID |
| `PATCH` | `/tasks/:id/status` | Transicionar estado de la tarea |

#### POST /tasks

```json
{
  "title": "Buscar vuelos a Madrid",
  "description": "Opcional",
  "metadata": {}
}
```

#### PATCH /tasks/:id/status

```json
{
  "status": "running"
}
```

Estados válidos: `pending` → `planning` → `running` → `waiting_for_approval` → `completed` / `failed` / `cancelled`

---

## WebSocket

Namespace: `ws://localhost:3000/eva`

### Conexión

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000/eva', {
  auth: { token: '<supabase-jwt>' }
});

socket.on('connected', ({ orgId }) => console.log('Sala:', orgId));
```

El servidor une automáticamente al cliente a la sala `org:<orgId>` para que solo reciba eventos de su organización.

### Eventos emitidos por el servidor

| Evento | Payload | Descripción |
|--------|---------|-------------|
| `task.created` | `{ taskId, payload, ts }` | Nueva tarea creada |
| `task.started` | `{ taskId, payload, ts }` | Tarea inició ejecución |
| `task.completed` | `{ taskId, payload, ts }` | Tarea completada |
| `task.failed` | `{ taskId, payload, ts }` | Tarea falló |
| `task.cancelled` | `{ taskId, payload, ts }` | Tarea cancelada |
| `approval.requested` | `{ taskId, payload, ts }` | Aprobación requerida |
| `approval.resolved` | `{ taskId, payload, ts }` | Aprobación resuelta |

### Eventos del cliente

| Evento | Descripción |
|--------|-------------|
| `ping` | Liveness check → responde `pong` |

---

## Event Bus (Redis Streams)

El Event Bus corre sobre Redis Streams en el stream `eva:events`. Todos los módulos internos pueden publicar y suscribirse a eventos.

```typescript
// Publicar
await eventBus.publish({
  type: 'task.created',
  orgId: 'uuid',
  taskId: 'uuid',
  payload: { title: '...' },
});

// Suscribirse
eventBus.on('task.completed', async (event) => {
  // procesar...
});
```

---

## Multi-tenancy y RLS

**Regla absoluta**: toda tabla tiene `org_id` y todo query filtra por él.

Las políticas RLS en `014_rls_policies.sql` garantizan aislamiento a nivel de base de datos:

```sql
-- Un usuario de org A nunca puede leer datos de org B
CREATE POLICY "tasks_select" ON tasks
  FOR SELECT USING (org_id = ANY(auth.user_org_ids()));
```

Para verificar el aislamiento:

```sql
-- Conectado como usuario de org A, esto debe devolver 0 filas de org B
SELECT * FROM tasks WHERE org_id = '<uuid-org-b>';
```

---

## Tests

### Backend (eva-core)

```bash
cd apps/eva-core

# Tests unitarios
npm test

# Tests E2E (DB mockeada, no requiere Supabase real)
npm run test:e2e

# Tests E2E incluyendo verificación real de RLS en Supabase
RLS_TEST=true npm run test:e2e

# Watch mode
npm run test:watch
```

Los tests E2E levantan la app NestJS completa con mocks de `DatabaseService` y `EventBusService`. No requieren Redis ni Postgres reales.

Para los tests de RLS (`RLS_TEST=true`) necesitas un proyecto Supabase real con las migraciones aplicadas y las variables de entorno configuradas.

### Dashboard (eva-dashboard)

```bash
cd apps/eva-dashboard

# Tests unitarios + componentes
npm test

# CI mode (sin watch)
npm run test:ci

# Watch mode
npm run test:watch
```

### Verificación completa antes de merge

```bash
# Desde la raíz
cd apps/eva-core && npm run build && npm run lint && npm test && npm run test:e2e
cd ../eva-dashboard && npm run build && npm run lint && npm test
```

---

## Conexión con LLMs / APIs externas (fases futuras)

Las siguientes variables se añadirán en fases posteriores del proyecto:

### Model Router (Fase 4)

```env
# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_DEFAULT_MODEL=gpt-4o

# Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_DEFAULT_MODEL=claude-3-5-sonnet-20241022
```

### Communication Hub (Fase 9)

```env
# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...

# Discord
DISCORD_BOT_TOKEN=...
DISCORD_WEBHOOK_SECRET=...

# Email (Resend / SMTP)
RESEND_API_KEY=...
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
```

### MCP Manager (Fase 11)

```env
# GitHub MCP
GITHUB_TOKEN=...

# AWS MCP
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
```

> Todos los secretos van exclusivamente en variables de entorno. **Nunca** en código ni en el cliente.

---

## Fases de desarrollo

| Fase | Entregable | Estado |
|------|------------|--------|
| 1 · Core mínimo | API Gateway, Auth, Task Engine, Event Bus, WebSocket | ✅ Completo |
| 2 · Dashboard | Panel Next.js (login, tareas, nodos, eventos, logs) | ✅ Completo |
| 3 · Memory System | Memory Agent, embeddings pgvector, búsqueda semántica | Pendiente |
| 4 · Planner + LLM | Model Router, Planner, Tool Router, Intent Router | Pendiente |
| 5 · Server/Desktop Node | Node App, heartbeat, capability registry | Pendiente |
| 6 · Dev Manager | Project Registry, Claude Code Controller, Dev Queue | Pendiente |
| 7 · Browser Agent | Playwright, perfiles, screenshots | Pendiente |
| 8 · Approval Engine | Niveles 0-3, action_hash, UI de aprobación | Pendiente |
| 9 · Communication Hub | Telegram, Discord, email, push | Pendiente |
| 10 · Skill System | Registry, loader, permisos, versioning | Pendiente |
| 11 · MCP Manager | Gateway MCP, adapters GitHub/Supabase/Google/AWS | Pendiente |
| 12 · Experience System | Traces, feedback, detección de patrones | Pendiente |
| 13 · Wear Token / Fast Path | Tokens efímeros, policy, cost guard | Pendiente |

Ver [doc/06 - Plan de Ejecución por Fases.md](doc/06%20-%20Plan%20de%20Ejecución%20por%20Fases.md) para el roadmap completo.

---

## Approval Engine

Las acciones con dinero, producción o datos sensibles pasan por el Approval Engine (disponible desde Fase 8):

```
acción preparada → action_hash = sha256(payload normalizado) + nonce + expires_at
                → aprobador humano valida en dashboard
                → ejecutor verifica hash antes de correr
```

Niveles:
- **0** — auto-aprobado (bajo riesgo)
- **1** — confirmación única
- **2** — aprobación explícita con screenshot
- **3** — dos aprobadores distintos requeridos

---

## Migraciones: referencia rápida

```bash
# Aplicar todas con Supabase CLI
supabase db push

# Aplicar manualmente una migración específica
psql $DATABASE_URL -f supabase/migrations/001_extensions.sql
```

Para desarrollo local con Docker, las migraciones se montan automáticamente en `/docker-entrypoint-initdb.d/migrations/` y se aplican al inicializar el contenedor.

---

## Comandos útiles

```bash
# Levantar solo infraestructura
docker compose up -d postgres redis

# Ver logs del backend
docker compose logs -f eva-core

# Detener todo
docker compose down

# Limpiar volúmenes (⚠️ borra datos)
docker compose down -v

# Build de producción del backend
cd apps/eva-core && npm run build && npm start

# Build de producción del dashboard
cd apps/eva-dashboard && npm run build && npm start
```

---

## Seguridad

- **Multi-tenant estricto**: `org_id` en toda tabla, todo query, toda política RLS.
- **Secretos**: exclusivamente en variables de entorno; nunca en código, logs ni cliente.
- **JWT**: validado por Supabase JWT Secret en cada request.
- **Rate limiting**: Throttler con ventana configurable (`THROTTLE_TTL` / `THROTTLE_LIMIT`).
- **WebSocket**: autenticación JWT obligatoria al conectar; desconexión inmediata si inválido.
- **Anti-injection**: contenido externo (web, correos, archivos) se trata como datos, no instrucciones.
- **OWASP**: sin secrets en cliente, validación de inputs con `class-validator`, CORS configurado explícitamente.
