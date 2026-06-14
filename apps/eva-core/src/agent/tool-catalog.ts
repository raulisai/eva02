/**
 * Tool catalog — the 33 ToolSpec definitions that the agent loop exposes to the model.
 *
 * Extracted from AgentLoopService so the catalog (data/executors) and the loop
 * (control flow) have separate reasons to change. Adding or editing a tool only
 * touches this file; loop logic changes only touch agent-loop.service.ts.
 *
 * Pattern: `buildToolCatalog(deps)` is a pure factory — no class, no DI decorator.
 * AgentLoopService calls it once in the constructor and stores the result.
 */

import * as fs from 'node:fs/promises';
import * as pathLib from 'node:path';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { GmailService } from './gmail.service';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleDriveService } from './google-drive.service';
import { DatabaseService } from '../database/database.service';
import { SandboxLanguage, SandboxService } from './sandbox.service';
import { ScheduleService } from './schedule.service';
import { ScriptForgeService } from './script-forge.service';
import { SkillLibraryService } from './skill-library.service';
import { SkillDocsService } from './skill-docs.service';
import { TelegramAdapter } from '../communication/telegram.adapter';
import { DELEGATE_ROLE_CATALOG } from './agent-profiles';
import { wantsEvidence } from './evidence';
import { WhatsAppWebService } from '../integrations/whatsapp-web.service';
import { UberWebService } from '../integrations/uber-web.service';
import { RappiWebService } from '../integrations/rappi-web.service';
import { ScheduledJobsService } from '../jobs/scheduled-jobs.service';
import { AgentIntelligenceService } from './agent-intelligence.service';
import { ResearchToolsService } from './research-tools.service';

const logger = new Logger('ToolCatalog');

/** All services the tool executors need — injected once from AgentLoopService. */
export interface ToolCatalogDeps {
  db: DatabaseService;
  modelRouter: ModelRouterService;
  research: ResearchToolsService;
  gmail: GmailService;
  calendar: GoogleCalendarService;
  schedule: ScheduleService;
  drive: GoogleDriveService;
  memoryAgent: MemoryAgentService;
  forge: ScriptForgeService;
  sandbox: SandboxService;
  skillLibrary: SkillLibraryService;
  skillDocs: SkillDocsService;
  whatsapp: WhatsAppWebService;
  uber: UberWebService;
  rappi: RappiWebService;
  scheduledJobs: ScheduledJobsService;
  intelligence?: AgentIntelligenceService;
  approvals?: ApprovalsService;
  integrations?: IntegrationsService;
  telegram?: TelegramAdapter;
  /** Helpers that live in the loop service and are called by some executors. */
  formatSandboxResult: (result: { ok: boolean; output: string; timedOut?: boolean; error?: string }) => string;
  isBrittleRawPdfSkill: (code: string) => boolean;
  validateOutgoingArtifact: (filename: string, buffer: Buffer) => string | null;
  expandSkillInlineShell: (content: string, orgId: string, taskId: string) => Promise<string>;
  saveArtifact: (orgId: string, taskId: string, title: string, content: string, metadata: Record<string, unknown>) => Promise<void>;
}

export interface ToolSpec {
  name: string;
  usage: string;
  inputSchema: Record<string, unknown>;
  execute: (orgId: string, taskId: string, args: Record<string, unknown>) => Promise<string>;
  zodSchema?: z.ZodSchema;
  rootOnly?: boolean;
}

export function buildToolCatalog(deps: ToolCatalogDeps): ToolSpec[] {
  const {
    db, modelRouter, research, gmail, calendar, schedule, drive, memoryAgent,
    forge, sandbox, skillLibrary, skillDocs, whatsapp, uber, rappi, scheduledJobs,
    intelligence, approvals, integrations, telegram,
    formatSandboxResult, isBrittleRawPdfSkill, validateOutgoingArtifact,
    expandSkillInlineShell, saveArtifact,
  } = deps;

  return [
    {
      name: 'web_search',
      usage: 'web_search{"query"}: busca en internet/APIs públicas (clima, noticias, precios, lugares, datos actuales).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Término o pregunta a buscar.' } },
        required: ['query'],
      },
      execute: async (orgId, _taskId, args) => {
        const query = String(args.query ?? '').trim();
        if (!query) return 'ERROR: web_search requiere args.query';
        const answer = await research.answer(query, orgId);
        return answer.text;
      },
    },
    {
      name: 'gmail_read',
      usage: 'gmail_read{"query"?}: lee correos del usuario; query opcional estilo Gmail (from:, subject:, texto).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Filtro estilo Gmail (from:, subject:, palabra clave). Omitir = últimos 3 correos.' } },
      },
      execute: async (orgId, _taskId, args) => {
        const query = String(args.query ?? '').trim();
        const result = query
          ? await gmail.fetchSearchWithFallback(orgId, query)
          : await gmail.fetchLatest(orgId, 3);
        return result.ok ? result.text : `ERROR: gmail ${result.reason}${result.error ? ` — ${result.error}` : ''}`;
      },
    },
    {
      name: 'calendar_read',
      usage: 'calendar_read{"days"?}: agenda próxima del usuario (local + Google Calendar).',
      inputSchema: {
        type: 'object',
        properties: { days: { type: 'number', description: 'Días hacia adelante (1-30, default 7).' } },
      },
      execute: async (orgId, _taskId, args) => {
        const days = Math.min(Math.max(Number(args.days ?? 7) || 7, 1), 30);
        const [local, gcal] = await Promise.all([
          schedule.formatUpcomingForSoul(orgId, days).catch(() => null),
          calendar.formatUpcomingForSoul(orgId, days).catch(() => null),
        ]);
        const merged = [local, gcal].filter(Boolean).join('\n');
        return merged || 'Sin eventos próximos en la agenda.';
      },
    },
    {
      name: 'drive_read',
      usage: 'drive_read{"query"}: busca archivos/carpetas en el Google Drive del usuario.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Nombre o descripción del archivo/carpeta a buscar.' } },
        required: ['query'],
      },
      execute: async (orgId, _taskId, args) => {
        const query = String(args.query ?? '').trim();
        if (!query) return 'ERROR: drive_read requiere args.query';
        const result = await drive.fetchForQuery(orgId, query);
        return result.ok ? result.text : `ERROR: drive ${result.reason}${result.error ? ` — ${result.error}` : ''}`;
      },
    },
    {
      name: 'memory_recall',
      usage: 'memory_recall{"query"}: recuerda conversaciones, datos y soluciones pasadas del usuario.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Tema o pregunta a recordar.' } },
        required: ['query'],
      },
      execute: async (orgId, _taskId, args) => {
        const query = String(args.query ?? '').trim();
        if (!query) return 'ERROR: memory_recall requiere args.query';
        const memories = await memoryAgent.recall(query, orgId, 5, 0.6);
        if (memories.length === 0) return 'Sin memorias relevantes.';
        return memories.map((m) => `[${m.created_at.slice(0, 10)}] ${m.summary}`).join('\n');
      },
    },
    {
      name: 'ask_user',
      usage: 'ask_user{"question","options"?,"timeout_minutes"?}: pregunta al usuario cuando falta una decisión, dato crítico o señal externa; pausa la tarea en waiting_for_input. Usa timeout_minutes largo (ej. 1440) para standby de horas/días.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Pregunta breve y concreta para el usuario.' },
          options: { type: 'array', items: { type: 'string' }, description: 'Opciones sugeridas opcionales.' },
          timeout_minutes: { type: 'number', description: 'Minutos antes de reanudar por timeout; 15 por defecto, max 10080.' },
        },
        required: ['question'],
      },
      rootOnly: true,
      execute: async (orgId, taskId, args) => {
        if (!intelligence) return 'ERROR: ask_user no disponible en este contexto.';
        const question = String(args.question ?? '').trim();
        if (!question) return 'ERROR: ask_user requiere args.question';
        const options = Array.isArray(args.options) ? args.options.map((o) => String(o)).filter(Boolean).slice(0, 5) : [];
        const timeoutMinutes = typeof args.timeout_minutes === 'number' ? args.timeout_minutes : 15;
        return intelligence.askUser(orgId, taskId, question, options, timeoutMinutes);
      },
    },
    {
      name: 'code_execute',
      usage: 'code_execute{"language":"python|node|bash","code","network"?,"session"?}: ejecuta TU código literal en el sandbox de la tarea. /work persiste entre pasos; imprime resultados por stdout. python/bash corren en una terminal VIVA (cwd y env compartidos con terminal_run de la misma "session"); usa "session" (0-9) para correr en paralelo (ej. server en 1, pruebas en 0). Sin red por defecto (pasa "network":true para descargar de internet o llamar APIs externas; en este entorno la red está permitida y no requiere aprobación humana). Python incluye requests/pandas/numpy si la imagen eva-sandbox está instalada.',
      inputSchema: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['python', 'node', 'bash'], description: 'Lenguaje del código.' },
          code: { type: 'string', description: 'Código a ejecutar. Usa print()/console.log() para ver resultados.' },
          network: { type: 'boolean', description: 'true = permitir acceso a red (para descargas y llamadas a APIs).' },
          session: { type: 'number', description: 'Terminal/sesión paralela (0-9, def. 0). El estado de shell (cwd, env) se comparte con terminal_run de la misma sesión.' },
        },
        required: ['language', 'code'],
      },
      execute: async () => 'ERROR: code_execute no disponible',
    },
    {
      name: 'terminal_run',
      usage: 'terminal_run{"cmd","session"?,"background"?}: comando de shell en una terminal VIVA del sandbox (cwd /work, estado persistente: cd, export, venv). "session" (0-9) abre terminales paralelas (ej. server en 1, pruebas en 0). Si el comando pide input verás [SISTEMA: espera input] → responde con terminal_input. Si sigue corriendo, léelo con terminal_output. background:true lo lanza detached.',
      inputSchema: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'Comando de shell a ejecutar en /work.' },
          session: { type: 'number', description: 'Número de terminal paralela (0 por defecto).' },
          background: { type: 'boolean', description: 'true = ejecutar detached (leer con terminal_output).' },
        },
        required: ['cmd'],
      },
      execute: async (orgId, taskId, args) => {
        const cmd = String(args.cmd ?? '').trim();
        if (!cmd) return 'ERROR: terminal_run requiere args.cmd';
        const result = await sandbox.execInSession(taskId, {
          kind: 'terminal', code: cmd, orgId,
          background: args.background === true,
          session: typeof args.session === 'number' ? args.session : 0,
        });
        return formatSandboxResult(result);
      },
    },
    {
      name: 'terminal_input',
      usage: 'terminal_input{"keyboard","session"?}: envía texto al stdin de un comando que está esperando input (cuando terminal_run/code_execute reportó [SISTEMA: espera input]). Ej. "y" para confirmar, una contraseña, o una respuesta a un prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          keyboard: { type: 'string', description: 'Texto a enviar (se le añade Enter automáticamente).' },
          session: { type: 'number', description: 'Número de terminal donde está el comando (0 por defecto).' },
        },
        required: ['keyboard'],
      },
      execute: async (_orgId, taskId, args) => {
        const result = await sandbox.sendShellInput(taskId, {
          keyboard: String(args.keyboard ?? ''),
          session: typeof args.session === 'number' ? args.session : 0,
        });
        return formatSandboxResult(result);
      },
    },
    {
      name: 'terminal_output',
      usage: 'terminal_output{"session"?}: reanuda la lectura de un comando que seguía corriendo en una terminal viva (o lee el log de un proceso en background).',
      inputSchema: {
        type: 'object',
        properties: { session: { type: 'number', description: 'Número de terminal (0 por defecto).' } },
      },
      execute: async (_orgId, taskId, args) => {
        const result = await sandbox.readShellOutput(taskId, {
          session: typeof args.session === 'number' ? args.session : 0,
        });
        return formatSandboxResult(result);
      },
    },
    {
      name: 'skill_run',
      usage: 'skill_run{"slug"}: re-ejecuta una skill guardada (código ya probado) en el sandbox, sin regenerarla.',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'Slug de la skill a ejecutar.' } },
        required: ['slug'],
      },
      execute: async (orgId, taskId, args) => {
        const slug = String(args.slug ?? '').trim();
        if (!slug) return 'ERROR: skill_run requiere args.slug';
        const skill = await skillLibrary.getRunnable(orgId, slug);
        if (!skill) return `ERROR: no encontré la skill "${slug}" (¿slug correcto y activa?)`;
        if (isBrittleRawPdfSkill(skill.code)) {
          const deleted = await skillDocs.deleteSkill(orgId, slug).catch((err) => ({
            ok: false,
            error: (err as Error).message,
          }));
          const suffix = deleted.ok ? 'La archivé para que no vuelva a contaminar el índice.' : `No pude archivarla automáticamente: ${deleted.error}`;
          return [
            `ERROR: la skill "${slug}" parece generar PDF crudo con xref/startxref hardcodeado, una ruta que ya produjo PDFs en blanco o inválidos.`,
            suffix,
            'Reimplementa con code_execute desde cero, calcula/verifica el PDF en runtime y guarda una skill nueva sólo después de que telegram_send_file confirme un envío exitoso.',
          ].join(' ');
        }
        const result = await sandbox.execInSession(taskId, {
          kind: skill.language, code: skill.code, orgId,
        });
        return `[skill ${slug}] ${formatSandboxResult(result)}`;
      },
    },
    {
      name: 'skill_save',
      usage: 'skill_save{"name","description","language":"python|node|bash","code"}: guarda código YA PROBADO como skill reutilizable (pasa por un escáner de seguridad). Úsalo tras verificar que funciona; mismo name = nueva versión.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre corto de la skill.' },
          description: { type: 'string', description: 'Qué hace esta skill.' },
          language: { type: 'string', enum: ['python', 'node', 'bash'] },
          code: { type: 'string', description: 'Código ya verificado que funciona.' },
        },
        required: ['name', 'description', 'language', 'code'],
      },
      execute: async (orgId, taskId, args) => {
        const code = String(args.code ?? '').trim();
        const name = String(args.name ?? '').trim();
        const description = String(args.description ?? '').trim();
        if (!code || !name || !description) return 'ERROR: skill_save requiere args.name, args.description y args.code';
        const rawLang = String(args.language ?? 'python');
        const language: SandboxLanguage = rawLang === 'node' || rawLang === 'bash' ? rawLang : 'python';
        const result = await skillLibrary.register(orgId, {
          displayName: name, description, language, code, origin: 'agent-loop', taskId,
        });
        if (!result.ok) return `ERROR: ${result.reason}`;
        await saveArtifact(orgId, taskId, `${result.slug}.${language === 'python' ? 'py' : language === 'node' ? 'js' : 'sh'}`, code, {
          language, skill_slug: result.slug, origin: 'agent-loop',
        });
        return `Skill "${result.slug}" v${result.version} guardada (y como artifact). Reutilízala con skill_run{"slug":"${result.slug}"}.`;
      },
    },
    {
      name: 'skill_view',
      usage: 'skill_view{"slug","file_path"?}: carga el contenido completo de una skill (SKILL.md) o un archivo de soporte (references/api.md, templates/config.yaml, scripts/check.sh). Usa cuando el índice de skills indica que una es relevante.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Slug de la skill a cargar.' },
          file_path: { type: 'string', description: 'Ruta de archivo de soporte opcional: "references/api.md", "templates/config.yaml", etc.' },
        },
        required: ['slug'],
      },
      execute: async (orgId, taskId, args) => {
        const slug = String(args.slug ?? '').trim();
        if (!slug) return 'ERROR: skill_view requiere args.slug';
        const filePath = args.file_path ? String(args.file_path).trim() : undefined;

        if (filePath) {
          let content = await skillDocs.viewSkillFile(orgId, slug, filePath);
          if (!content) return `ERROR: Archivo '${filePath}' no encontrado en skill '${slug}'.`;
          content = skillDocs.substituteTemplateVars(content, { skillDir: `skill://${slug}`, taskId }) ?? content;
          content = await expandSkillInlineShell(content, orgId, taskId);
          return `[${slug}/${filePath}]\n\n${content}`;
        }

        const skill = await skillDocs.viewSkill(orgId, slug, { taskId });
        if (!skill) return `ERROR: Skill '${slug}' no encontrada. Usa skill_manage(action="list") o revisa el índice de skills.`;
        void skillDocs.recordSkillView(orgId, slug, skill.source);

        const body = await expandSkillInlineShell(
          skill.content_md ?? '(sin contenido — usa skill_manage para añadir instrucciones)',
          orgId,
          taskId,
        );

        const parts: string[] = [
          `[Skill: ${skill.display_name} (${slug})]`,
          skill.description,
          '',
          body,
        ];
        if (skill.files.length > 0) {
          parts.push('', '[Archivos de soporte:]');
          for (const f of skill.files) {
            parts.push(`  - ${f.path}  →  skill_view{"slug":"${slug}","file_path":"${f.path}"}`);
          }
          parts.push('Carga cualquiera con skill_view(slug, file_path="...").');
        }
        if (skill.related_skills.length > 0) {
          parts.push('', '[Skills relacionadas (grafo de uso):]');
          for (const r of skill.related_skills) {
            parts.push(`  - ${r.slug} (${r.relation})  →  skill_view{"slug":"${r.slug}"}`);
          }
        }
        return parts.join('\n');
      },
    },
    {
      name: 'skill_manage',
      usage: 'skill_manage{"action":"create|patch|edit|write_file|remove_file|delete","slug","content_md"?,...}: gestiona skills como memoria procedimental. create=nueva skill, patch=find&replace, edit=reescribir, write_file=guardar archivo de soporte, delete=archivar.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'patch', 'edit', 'write_file', 'remove_file', 'delete'], description: 'Acción a realizar.' },
          slug: { type: 'string', description: 'Slug de la skill (lowercase, guiones).' },
          display_name: { type: 'string', description: 'Nombre legible (solo para create).' },
          description: { type: 'string', description: 'Descripción corta ≤120 chars (solo para create).' },
          category: { type: 'string', description: 'Categoría slug, ej: "coding", "research", "workflow".' },
          content_md: { type: 'string', description: 'Contenido Markdown de SKILL.md (para create/edit).' },
          patch_find: { type: 'string', description: 'Texto exacto a buscar (solo para patch).' },
          patch_replace: { type: 'string', description: 'Texto de reemplazo (solo para patch).' },
          file_path: { type: 'string', description: 'Ruta del archivo de soporte, ej: "references/api.md" (para write_file/remove_file/patch).' },
          file_content: { type: 'string', description: 'Contenido del archivo de soporte (para write_file).' },
        },
        required: ['action', 'slug'],
      },
      execute: async (orgId, _taskId, args) => {
        const action = String(args.action ?? '').trim();
        const slug = String(args.slug ?? '').trim();
        if (!action || !slug) return 'ERROR: skill_manage requiere args.action y args.slug';

        let result;
        switch (action) {
          case 'create': {
            const contentMd = String(args.content_md ?? '').trim();
            if (!contentMd) return 'ERROR: skill_manage create requiere args.content_md';
            result = await skillDocs.createSkill(orgId, {
              slug, displayName: String(args.display_name ?? slug),
              description: String(args.description ?? '').slice(0, 500),
              category: args.category ? String(args.category) : undefined,
              contentMd, origin: 'agent-loop',
            });
            break;
          }
          case 'edit': {
            const contentMd = String(args.content_md ?? '').trim();
            if (!contentMd) return 'ERROR: skill_manage edit requiere args.content_md';
            result = await skillDocs.editSkill(orgId, slug, contentMd);
            break;
          }
          case 'patch': {
            const find = String(args.patch_find ?? '').trim();
            const replace = String(args.patch_replace ?? '');
            if (!find) return 'ERROR: skill_manage patch requiere args.patch_find';
            result = await skillDocs.patchSkill(orgId, {
              slug, find, replace,
              filePath: args.file_path ? String(args.file_path) : undefined,
            });
            break;
          }
          case 'write_file': {
            const filePath = String(args.file_path ?? '').trim();
            const fileContent = String(args.file_content ?? '').trim();
            if (!filePath || !fileContent) return 'ERROR: skill_manage write_file requiere args.file_path y args.file_content';
            const parts = filePath.split('/');
            if (parts.length !== 2) return 'ERROR: file_path debe ser "subdir/filename", ej: "references/api.md"';
            const [subdir, filename] = parts;
            const validSubdirs = ['references', 'templates', 'scripts', 'assets'];
            if (!validSubdirs.includes(subdir)) return `ERROR: subdir debe ser uno de: ${validSubdirs.join(', ')}`;
            result = await skillDocs.writeSkillFile(orgId, {
              slug, subdir: subdir as 'references' | 'templates' | 'scripts' | 'assets', filename, content: fileContent,
            });
            break;
          }
          case 'remove_file': {
            const filePath = String(args.file_path ?? '').trim();
            if (!filePath) return 'ERROR: skill_manage remove_file requiere args.file_path';
            result = await skillDocs.removeSkillFile(orgId, slug, filePath);
            break;
          }
          case 'delete':
            result = await skillDocs.deleteSkill(orgId, slug);
            break;
          default:
            return `ERROR: action desconocida "${action}". Usa: create, patch, edit, write_file, remove_file, delete.`;
        }
        if (!result.ok) return `ERROR: ${result.error}`;
        return result.message;
      },
    },
    {
      name: 'script_forge',
      usage: 'script_forge{"spec"}: pide a un modelo especializado escribir Y ejecutar un script completo (queda registrado como skill reutilizable). Prefiere code_execute para iterar tú mismo.',
      inputSchema: {
        type: 'object',
        properties: { spec: { type: 'string', description: 'Descripción detallada de qué debe hacer el script.' } },
        required: ['spec'],
      },
      execute: async (orgId, taskId, args) => {
        const spec = String(args.spec ?? '').trim();
        if (!spec) return 'ERROR: script_forge requiere args.spec';
        const outcome = await forge.forge(orgId, taskId, spec, async () => undefined);
        return outcome.executed
          ? `Script ${outcome.filename} (${outcome.language}) ejecutado.${outcome.skillSlug ? ` Skill: ${outcome.skillSlug}.` : ''} Salida:\n${outcome.output || '(sin salida)'}`
          : `Script ${outcome.filename} generado pero no ejecutado: ${outcome.note ?? 'sandbox no disponible'}`;
      },
    },
    {
      name: 'delegate',
      usage: `delegate{"goal","role"?}: delega un sub-objetivo acotado a un sub-agente especializado. Roles: ${DELEGATE_ROLE_CATALOG}. Divide tareas grandes; no delegues el objetivo completo.`,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Sub-objetivo concreto y acotado.' },
          role: { type: 'string', description: `Rol del sub-agente: ${DELEGATE_ROLE_CATALOG}.` },
        },
        required: ['goal'],
      },
      rootOnly: true,
      execute: async () => 'ERROR: delegate no disponible',
    },
    {
      name: 'image_analyze',
      usage: 'image_analyze{"path","prompt"?}: analiza una imagen guardada en el sandbox o desde una URL pública, usando un modelo de visión.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta de la imagen en /work o URL pública.' },
          prompt: { type: 'string', description: 'Qué analizar en la imagen.' },
        },
        required: ['path'],
      },
      execute: async (orgId, taskId, args) => {
        const pathArg = String(args.path ?? '').trim();
        if (!pathArg) return 'ERROR: image_analyze requiere args.path';
        const prompt = String(args.prompt ?? 'Extrae todo el texto legible de la imagen con el mayor detalle posible.').trim();

        let buffer: Buffer;
        let mimeType = 'image/png';
        try {
          if (pathArg.startsWith('http://') || pathArg.startsWith('https://')) {
            const res = await fetch(pathArg);
            if (!res.ok) throw new Error(`HTTP status ${res.status}`);
            buffer = Buffer.from(await res.arrayBuffer());
            const ct = res.headers.get('content-type');
            if (ct) mimeType = ct;
          } else {
            let resolvedPath = pathArg;
            if (!pathLib.isAbsolute(resolvedPath)) {
              let cleanPath = pathArg;
              if (cleanPath.startsWith('/work/')) cleanPath = cleanPath.slice(6);
              else if (cleanPath.startsWith('work/')) cleanPath = cleanPath.slice(5);
              const hostDir = sandbox.getHostDir(taskId);
              if (hostDir) {
                const candidate = pathLib.join(hostDir, cleanPath);
                try { await fs.access(candidate); resolvedPath = candidate; } catch { /* keep */ }
              }
              if (!pathLib.isAbsolute(resolvedPath)) resolvedPath = pathLib.resolve(process.cwd(), cleanPath);
            }
            buffer = await fs.readFile(resolvedPath);
            const ext = pathLib.extname(resolvedPath).toLowerCase();
            if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
            else if (ext === '.gif') mimeType = 'image/gif';
            else if (ext === '.webp') mimeType = 'image/webp';
          }
        } catch (err) {
          return `ERROR al cargar la imagen: ${(err as Error).message}`;
        }
        try {
          const result = await modelRouter.generate(prompt, {
            orgId, taskId,
            imageBase64: buffer.toString('base64'),
            imageMimeType: mimeType,
            systemPrompt: 'Eres EVA, una asistente de IA capaz de ver y analizar imágenes y capturas de pantalla para resolver las peticiones del usuario con total precisión.',
          });
          return result.text || 'Sin respuesta del modelo de visión.';
        } catch (err) {
          return `ERROR al analizar con el modelo de visión: ${(err as Error).message}`;
        }
      },
    },
    {
      name: 'sandbox_ls',
      usage: 'sandbox_ls{"path"?}: lista los archivos en /work del sandbox de la tarea (o en un subdirectorio). Usa esto para verificar que un archivo fue descargado antes de enviarlo.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Subdirectorio dentro de /work (opcional).' } },
      },
      execute: async (_orgId, taskId, args) => {
        const subPath = String(args.path ?? '').trim().replace(/^\/work\/?/, '');
        const hostDir = sandbox.getHostDir(taskId);
        if (!hostDir) return 'No hay sesión sandbox activa para esta tarea. Ejecuta primero code_execute o terminal_run.';
        const targetDir = subPath ? pathLib.join(hostDir, subPath) : hostDir;
        try {
          const entries = await fs.readdir(targetDir, { withFileTypes: true });
          if (entries.length === 0) return '(directorio vacío)';
          const lines = await Promise.all(entries.map(async (e) => {
            if (e.isDirectory()) return `📁 ${e.name}/`;
            try {
              const stat = await fs.stat(pathLib.join(targetDir, e.name));
              const kb = (stat.size / 1024).toFixed(1);
              const mb = stat.size / 1024 / 1024;
              return `📄 ${e.name} (${mb >= 1 ? `${mb.toFixed(1)} MB` : `${kb} KB`})`;
            } catch { return `📄 ${e.name}`; }
          }));
          return lines.join('\n');
        } catch (err) {
          return `ERROR al listar directorio: ${(err as Error).message}`;
        }
      },
    },
    {
      name: 'telegram_send_file',
      usage: 'telegram_send_file{"file","caption"?,"chat_id"?}: envía un archivo del workspace (/work) directamente a Telegram.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Nombre del archivo en /work (ej. "video.mp4").' },
          caption: { type: 'string', description: 'Pie de foto/descripción del archivo.' },
          chat_id: { type: 'string', description: 'Chat ID de Telegram (opcional, se infiere de la tarea).' },
        },
        required: ['file'],
      },
      execute: async (orgId, taskId, args) => {
        if (!telegram) return 'ERROR: TelegramAdapter no disponible en este contexto.';
        const fileArg = String(args.file ?? '').trim().replace(/^\/work\/?/, '');
        if (!fileArg) return 'ERROR: telegram_send_file requiere args.file';
        const hostDir = sandbox.getHostDir(taskId);
        if (!hostDir) return 'ERROR: no hay sesión sandbox activa. El archivo debe existir en /work (usa code_execute primero).';
        const filePath = pathLib.join(hostDir, fileArg);
        let buffer: Buffer;
        try {
          buffer = await fs.readFile(filePath);
        } catch (err) {
          return `ERROR: no se pudo leer el archivo "${fileArg}" desde /work: ${(err as Error).message}. Usa sandbox_ls para ver los archivos disponibles.`;
        }
        const caption = String(args.caption ?? '').trim() || undefined;
        const filename = pathLib.basename(fileArg);
        const qualityError = validateOutgoingArtifact(filename, buffer);
        if (qualityError) return qualityError;

        let chatId = String(args.chat_id ?? '').trim();
        if (!chatId) {
          try {
            const { data: task } = await db.admin.from('tasks').select('metadata, created_by').eq('id', taskId).eq('org_id', orgId).maybeSingle();
            const meta = (task?.metadata ?? {}) as Record<string, unknown>;
            chatId = String(meta['chat_id'] ?? meta['telegram_chat_id'] ?? '');
            if (!chatId && task?.created_by) {
              const { data: acc } = await db.admin.from('communication_accounts').select('external_chat_id').eq('org_id', orgId).eq('user_id', task.created_by).eq('channel', 'telegram').eq('status', 'active').maybeSingle();
              if (acc?.external_chat_id) chatId = acc.external_chat_id;
            }
          } catch { /* ignore */ }
        }
        if (!chatId) return 'ERROR: no se encontró chat_id de Telegram. Pasa args.chat_id explícitamente o asegúrate de que la tarea venga de un mensaje de Telegram.';

        let botToken: string | null | undefined;
        if (integrations) botToken = await integrations.getSecret(orgId, 'channel', 'telegram').catch(() => null);

        const result = await telegram.sendDocument({ chat_id: chatId }, buffer, filename, caption, botToken);
        if (!result.ok) {
          if ((result as { oversized?: boolean }).oversized) {
            return `ADVERTENCIA: ${result.error} — El agente descargó el archivo correctamente en /work pero no puede enviarlo porque supera el límite de Telegram. Opciones: (1) usa code_execute para comprimirlo con ffmpeg, (2) dile al usuario que lo descargue directamente.`;
          }
          return `ERROR al enviar a Telegram: ${result.error}`;
        }
        const sizeMb = (buffer.length / 1024 / 1024).toFixed(1);
        return `✅ Archivo "${filename}" (${sizeMb} MB) enviado a Telegram (chat ${chatId}, message_id=${result.externalMessageId ?? 'N/A'})`;
      },
    },
    {
      name: 'whatsapp_send',
      usage: 'whatsapp_send{"contact","text"}: prepara y envía un mensaje de WhatsApp. El envío real requiere aprobación humana.',
      inputSchema: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: 'Nombre del contacto o grupo.' },
          text: { type: 'string', description: 'Mensaje de texto a enviar.' },
        },
        required: ['contact', 'text'],
      },
      execute: async (orgId, taskId, args) => {
        if (!approvals) return 'ERROR: ApprovalsService no disponible.';
        const contact = String(args.contact ?? '').trim();
        const text = String(args.text ?? '').trim();
        if (!contact || !text) return 'ERROR: whatsapp_send requiere contact y text.';
        const session = await whatsapp.startSession(orgId, taskId);
        if (session.state === 'qr_required') return 'ERROR: WhatsApp Web requiere vinculación QR. Primero dile al usuario que escanee el QR desde el dashboard.';
        const { data: task } = await db.admin.from('tasks').select('created_by, description').eq('id', taskId).eq('org_id', orgId).maybeSingle();
        const userId = task?.created_by ?? 'system';
        await approvals.requestForPreparedAction({
          orgId, userId, taskId,
          actionType: 'whatsapp.message.send', source: 'browser',
          payload: { session_id: session.session_id, contact, text, send_evidence: wantsEvidence(task?.description) },
          summary: `Enviar WhatsApp a ${contact}: ${text.slice(0, 160)}`,
        });
        return `Petición de envío de WhatsApp creada para "${contact}". El usuario ya recibió la solicitud de aprobación por su canal. Cierra con final_answer BREVE: dile qué mensaje se enviará a quién y que responda "sí" para aprobarlo o "no" para cancelar. No incluyas hashes ni detalles técnicos.`;
      },
    },
    {
      name: 'whatsapp_read',
      usage: 'whatsapp_read{"contact"?,"unread_only"?,"unanswered_only"?}: lee mensajes recientes de WhatsApp.',
      inputSchema: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: 'Nombre de contacto para leer su historial específico (opcional).' },
          unread_only: { type: 'boolean', description: 'true: solo lee mensajes sin leer de todos los chats.' },
          unanswered_only: { type: 'boolean', description: 'true: solo lee chats pendientes de respuesta.' },
        },
      },
      execute: async (orgId, taskId, args) => {
        const contact = String(args.contact ?? '').trim();
        const unreadOnly = !!args.unread_only;
        const unansweredOnly = !!args.unanswered_only;
        const session = await whatsapp.startSession(orgId, taskId);
        if (session.state === 'qr_required') return 'ERROR: WhatsApp Web requiere vinculación QR. Escanea el QR desde el dashboard.';
        const result = unansweredOnly
          ? await whatsapp.fetchUnansweredMessages(orgId, taskId)
          : contact
            ? await whatsapp.fetchContactMessages(orgId, contact, taskId)
            : unreadOnly
              ? await whatsapp.fetchUnreadMessages(orgId, taskId)
              : await whatsapp.fetchLatestMessage(orgId, taskId);

        let replyText = result.text;
        if (result.session.screenshot?.image_base64 && (contact || !unansweredOnly)) {
          try {
            const visionPrompt = `Aquí tienes la lista de mensajes extraídos por DOM:\n${('messages' in result && result.messages) ? result.messages.join('\n') : '(Ninguno extraído por DOM)'}\n\nAnaliza la captura de pantalla de WhatsApp Web provista para complementar la lista de mensajes si falta alguno.`;
            const visionRes = await modelRouter.generate(visionPrompt, {
              orgId, taskId,
              imageBase64: result.session.screenshot.image_base64,
              imageMimeType: result.session.screenshot.mime_type || 'image/png',
              systemPrompt: 'Eres EVA, una asistente capaz de analizar capturas de pantalla de WhatsApp Web.',
            });
            if (visionRes?.text) replyText = visionRes.text;
          } catch (err) {
            logger.warn(`Failed to analyze screenshot in loop tool: ${(err as Error).message}`);
          }
        }
        return replyText;
      },
    },
    {
      name: 'uber_quote',
      usage: 'uber_quote{"origin","destination"}: abre Uber Web con perfil local y obtiene una cotización visible para una ruta.',
      inputSchema: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: 'Dirección o lugar de salida.' },
          destination: { type: 'string', description: 'Dirección o lugar de destino.' },
        },
        required: ['origin', 'destination'],
      },
      execute: async (orgId, taskId, args) => {
        const origin = String(args.origin ?? '').trim();
        const destination = String(args.destination ?? '').trim();
        if (!origin || !destination) return 'ERROR: uber_quote requiere origin y destination.';
        const result = await uber.estimateRide(orgId, { origin, destination, taskId });
        return result.text;
      },
    },
    {
      name: 'uber_request_ride',
      usage: 'uber_request_ride{"origin","destination","ride_type"?}: prepara un viaje en Uber y solicita la aprobación del usuario.',
      inputSchema: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: 'Dirección o lugar de salida.' },
          destination: { type: 'string', description: 'Dirección o lugar de destino.' },
          ride_type: { type: 'string', description: 'Tipo de viaje (ej: UberX, Comfort).' },
        },
        required: ['origin', 'destination'],
      },
      execute: async (orgId, taskId, args) => {
        if (!approvals) return 'ERROR: ApprovalsService no disponible.';
        const origin = String(args.origin ?? '').trim();
        const destination = String(args.destination ?? '').trim();
        const rideType = String(args.ride_type ?? 'UberX').trim();
        if (!origin || !destination) return 'ERROR: uber_request_ride requiere origin y destination.';
        const originN = uber.normalizeAddress(origin);
        const destinationN = uber.normalizeAddress(destination);
        const estimate = await uber.estimateRide(orgId, { origin: originN, destination: destinationN, taskId });
        let price = 'Precio no disponible';
        if (estimate.ok && estimate.candidates.length > 0) {
          const matched = estimate.candidates.find((c) => c.label.toLowerCase().includes(rideType.toLowerCase()));
          price = matched ? matched.price : estimate.candidates[0].price;
        }
        const { data: task } = await db.admin.from('tasks').select('created_by').eq('id', taskId).eq('org_id', orgId).maybeSingle();
        const userId = task?.created_by ?? 'system';
        await approvals.requestForPreparedAction({
          orgId, userId, taskId, actionType: 'uber.ride.order', source: 'browser',
          payload: { origin: originN, destination: destinationN, ride_type: rideType, price },
          summary: `Pedir Uber (${rideType}) de ${originN} a ${destinationN} por ${price}`,
        });
        return `Petición de viaje de Uber creada. El precio estimado para ${rideType} es ${price}. El usuario ya recibió la solicitud de aprobación por su canal. Cierra con final_answer BREVE: dile el origen, destino y costo estimado, y pídele que apruebe diciendo "sí" o rechace diciendo "no".`;
      },
    },
    {
      name: 'known_places_manage',
      usage: 'known_places_manage{"action":"list|save","label"?,"address"?,"lat"?,"lng"?}: gestiona las ubicaciones conocidas del usuario.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'save'], description: 'Acción a realizar.' },
          label: { type: 'string', description: 'Nombre/etiqueta del lugar (ej. "casa", "trabajo").' },
          address: { type: 'string', description: 'Dirección física del lugar.' },
          lat: { type: 'number', description: 'Latitud opcional.' },
          lng: { type: 'number', description: 'Longitud opcional.' },
        },
        required: ['action'],
      },
      execute: async (orgId, taskId, args) => {
        const action = String(args.action ?? '').trim();
        if (action === 'list') {
          const places = await schedule.getPlaces(orgId);
          if (places.length === 0) return 'No tienes ubicaciones conocidas guardadas.';
          return places.map((p) => `- ${p.label}: ${p.address || 'Sin dirección'}${p.lat && p.lng ? ` (${p.lat}, ${p.lng})` : ''}`).join('\n');
        }
        if (action === 'save') {
          const label = String(args.label ?? '').trim().toLowerCase();
          const address = String(args.address ?? '').trim();
          if (!label || !address) return 'ERROR: guardar requiere label y address.';
          const addressN = uber.normalizeAddress(address);
          let lat: number | undefined = typeof args.lat === 'number' ? args.lat : undefined;
          let lng: number | undefined = typeof args.lng === 'number' ? args.lng : undefined;
          if (lat === undefined || lng === undefined) {
            try {
              const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addressN)}&format=json&limit=1`, { headers: { 'User-Agent': 'EVA-Agentic-Platform/1.0 (djoker@eva.ai)' } });
              if (res.ok) {
                const data = await res.json() as Array<{ lat: string; lon: string }>;
                if (data?.[0]) { lat = parseFloat(data[0].lat); lng = parseFloat(data[0].lon); }
              }
            } catch (err) { logger.warn(`Failed to auto-geocode place label ${label}: ${(err as Error).message}`); }
          }
          const upserted = await schedule.upsertPlace(orgId, label, { address: addressN, lat, lng, metadata: {} });
          return `✅ Ubicación guardada exitosamente: "${upserted.label}" -> ${upserted.address}${upserted.lat && upserted.lng ? ` (${upserted.lat}, ${upserted.lng})` : ''}`;
        }
        return 'ERROR: acción no soportada.';
      },
    },
    {
      name: 'uber_login',
      usage: 'uber_login{"email","password"?}: inicia el flujo de login por correo en Uber.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Correo electrónico del usuario.' },
          password: { type: 'string', description: 'Contraseña (opcional).' },
        },
        required: ['email'],
      },
      execute: async (orgId, taskId, args) => {
        const email = String(args.email ?? '').trim();
        const password = String(args.password ?? '').trim() || undefined;
        if (!email) return 'ERROR: email requerido.';
        const result = await uber.startEmailLogin(orgId, email, password, taskId);
        return result.text;
      },
    },
    {
      name: 'rappi_login',
      usage: 'rappi_login{"email"}: inicia el flujo de login por correo en Rappi.',
      inputSchema: {
        type: 'object',
        properties: { email: { type: 'string', description: 'Correo electrónico del usuario.' } },
        required: ['email'],
      },
      execute: async (orgId, taskId, args) => {
        const email = String(args.email ?? '').trim();
        if (!email) return 'ERROR: email requerido.';
        const result = await rappi.startEmailLogin(orgId, email, taskId);
        return result.text;
      },
    },
    {
      name: 'gmail_write',
      usage: 'gmail_write{"action":"send|reply|trash|archive|mark_read|mark_unread","to"?,"subject"?,"body"?,"message_id"?}: realiza operaciones de escritura en Gmail. Todo cambio requiere aprobación humana.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['send', 'reply', 'trash', 'archive', 'mark_read', 'mark_unread'], description: 'Acción a realizar.' },
          to: { type: 'string', description: 'Destinatario (para send).' },
          subject: { type: 'string', description: 'Asunto (para send).' },
          body: { type: 'string', description: 'Cuerpo del mensaje (para send/reply).' },
          message_id: { type: 'string', description: 'ID del correo a responder, borrar, archivar o marcar.' },
        },
        required: ['action'],
      },
      execute: async (orgId, taskId, args) => {
        if (!approvals) return 'ERROR: ApprovalsService no disponible.';
        const action = String(args.action ?? '');
        const to = String(args.to ?? '').trim();
        const subject = String(args.subject ?? '').trim();
        const body = String(args.body ?? '').trim();
        const messageId = String(args.message_id ?? '').trim();
        const { data: task } = await db.admin.from('tasks').select('created_by').eq('id', taskId).eq('org_id', orgId).maybeSingle();
        const userId = task?.created_by ?? 'system';
        let summary = '';
        let payload: Record<string, unknown> = {};
        if (action === 'send') {
          if (!to || !body) return 'ERROR: to y body requeridos para send.';
          summary = `Enviar correo a ${to}: ${subject || '(sin asunto)'}`;
          payload = { to, subject, body };
        } else if (action === 'reply') {
          if (!messageId || !body) return 'ERROR: message_id y body requeridos para reply.';
          summary = `Responder correo ID ${messageId}: ${body.slice(0, 100)}`;
          payload = { message_id: messageId, body };
        } else if (action === 'trash') {
          if (!messageId) return 'ERROR: message_id requerido para trash.';
          summary = `Mover correo ID ${messageId} a la papelera`;
          payload = { message_id: messageId };
        } else if (action === 'archive') {
          if (!messageId) return 'ERROR: message_id requerido para archive.';
          summary = `Archivar correo ID ${messageId}`;
          payload = { message_id: messageId };
        } else if (action === 'mark_read') {
          if (!messageId) return 'ERROR: message_id requerido para mark_read.';
          summary = `Marcar correo ID ${messageId} como leído`;
          payload = { message_id: messageId };
        } else if (action === 'mark_unread') {
          if (!messageId) return 'ERROR: message_id requerido para mark_unread.';
          summary = `Marcar correo ID ${messageId} como no leído`;
          payload = { message_id: messageId };
        }
        await approvals.requestForPreparedAction({ orgId, userId, taskId, actionType: `gmail.${action}`, source: 'system', payload, summary });
        return `Operación gmail.${action} preparada (${summary}). El usuario ya recibió la solicitud de aprobación por su canal. Cierra con final_answer BREVE: describe qué se hará y que responda "sí" para aprobarlo o "no" para cancelar. No incluyas hashes ni detalles técnicos.`;
      },
    },
    {
      name: 'calendar_write',
      usage: 'calendar_write{"action":"create|delete","summary"?,"start_time"?,"end_time"?,"description"?,"event_id"?}: realiza operaciones de escritura en Google Calendar. Requiere aprobación humana.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'delete'], description: 'Acción a realizar.' },
          summary: { type: 'string', description: 'Título del evento.' },
          start_time: { type: 'string', description: 'Fecha y hora de inicio (ISO 8601).' },
          end_time: { type: 'string', description: 'Fecha y hora de fin (ISO 8601).' },
          description: { type: 'string', description: 'Descripción o notas del evento.' },
          event_id: { type: 'string', description: 'ID del evento a eliminar.' },
        },
        required: ['action'],
      },
      execute: async (orgId, taskId, args) => {
        if (!approvals) return 'ERROR: ApprovalsService no disponible.';
        const action = String(args.action ?? '');
        const summaryParam = String(args.summary ?? '').trim();
        const startTime = String(args.start_time ?? '').trim();
        const endTime = String(args.end_time ?? '').trim();
        const description = String(args.description ?? '').trim();
        const eventId = String(args.event_id ?? '').trim();
        const { data: task } = await db.admin.from('tasks').select('created_by').eq('id', taskId).eq('org_id', orgId).maybeSingle();
        const userId = task?.created_by ?? 'system';
        let summary = '';
        let payload: Record<string, unknown> = {};
        if (action === 'create') {
          if (!summaryParam || !startTime || !endTime) return 'ERROR: summary, start_time y end_time requeridos para create.';
          summary = `Crear evento "${summaryParam}" en Google Calendar (${startTime})`;
          payload = { summary: summaryParam, start_time: startTime, end_time: endTime, description };
        } else if (action === 'delete') {
          if (!eventId) return 'ERROR: event_id requerido para delete.';
          summary = `Eliminar evento ID ${eventId} de Google Calendar`;
          payload = { event_id: eventId };
        }
        await approvals.requestForPreparedAction({ orgId, userId, taskId, actionType: `calendar.${action}`, source: 'system', payload, summary });
        return `Operación calendar.${action} preparada (${summary}). El usuario ya recibió la solicitud de aprobación por su canal. Cierra con final_answer BREVE: describe qué se hará y que responda "sí" para aprobarlo o "no" para cancelar. No incluyas hashes ni detalles técnicos.`;
      },
    },
    {
      name: 'scratchpad',
      usage: 'scratchpad{"action":"write|read|list","key"?,"content"?}: memoria de trabajo dentro de esta tarea. Guarda hallazgos largos por nombre y recupéralos cuando los necesites.',
      rootOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['write', 'read', 'list'], description: '"write" guarda contenido; "read" recupera; "list" muestra claves.' },
          key: { type: 'string', description: 'Nombre descriptivo, ej. "research:nvidia", "draft:resumen".' },
          content: { type: 'string', description: 'Contenido a guardar. Requerido para "write".' },
        },
        required: ['action'],
      },
      execute: async (orgId, taskId, args) => {
        const action = String(args.action ?? '');
        const { data: taskRow } = await db.admin.from('tasks').select('metadata').eq('id', taskId).eq('org_id', orgId).maybeSingle();
        const meta = (taskRow?.metadata ?? {}) as Record<string, unknown>;
        const pad = (meta['scratchpad'] ?? {}) as Record<string, string>;

        if (action === 'write') {
          const key = String(args.key ?? '').trim();
          const content = String(args.content ?? '');
          if (!key) return 'ERROR: key requerida para write.';
          if (!content) return 'ERROR: content requerido para write.';
          pad[key] = content;
          const { error } = await db.admin.from('tasks').update({ metadata: { ...meta, scratchpad: pad } }).eq('id', taskId).eq('org_id', orgId);
          if (error) return `ERROR al guardar en scratchpad: ${error.message}`;
          return `✅ scratchpad["${key}"] — ${content.length} chars guardados.`;
        }
        if (action === 'read') {
          const key = String(args.key ?? '').trim();
          if (!key) {
            const keys = Object.keys(pad);
            if (keys.length === 0) return 'Scratchpad vacío. Usa scratchpad:write para guardar hallazgos.';
            return keys.map((k) => `## ${k}\n${pad[k]}`).join('\n\n---\n\n');
          }
          if (!(key in pad)) {
            const available = Object.keys(pad).join(', ') || 'ninguna';
            return `No hay entrada scratchpad["${key}"]. Claves disponibles: ${available}`;
          }
          return pad[key];
        }
        if (action === 'list') {
          const keys = Object.keys(pad);
          if (keys.length === 0) return 'Scratchpad vacío — ningún hallazgo guardado aún en esta tarea.';
          return 'Contenido guardado en scratchpad:\n' + keys.map((k) => `- "${k}": ${pad[k].length} chars`).join('\n');
        }
        return 'ERROR: acción desconocida. Usa "write", "read" o "list".';
      },
    },
    {
      name: 'data_log',
      usage: 'data_log{"action":"write|read|delete","key":"<namespace>:<id>","value"?,"since"?,"limit"?}: acumula observaciones persistentes entre ejecuciones de jobs. Ideal para monitoring de largo plazo.',
      rootOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['write', 'read', 'delete'] },
          key: { type: 'string', description: 'Clave con namespace, ej. "stock:GOOGL".' },
          value: { type: 'string', description: 'Valor a guardar (JSON string o texto). Requerido para "write".' },
          since: { type: 'string', description: 'ISO date para filtrar entradas desde esa fecha.' },
          limit: { type: 'number', description: 'Máx de entradas a devolver en "read". Default 100.' },
        },
        required: ['action', 'key'],
      },
      execute: async (orgId, taskId, args) => {
        const action = String(args.action ?? '');
        const key = String(args.key ?? '').trim();
        if (!key) return 'ERROR: key es requerida.';
        if (action === 'write') {
          const value = args.value != null ? String(args.value) : '';
          if (!value) return 'ERROR: value es requerida para write.';
          const { error } = await db.admin.from('agent_data_log').insert({ org_id: orgId, key, value, job_id: taskId });
          if (error) return `ERROR: ${error.message}`;
          return `✅ Guardado en data_log [${key}] a las ${new Date().toISOString()}.`;
        }
        if (action === 'read') {
          const limit = Math.min(Number(args.limit ?? 100), 500);
          let query = db.admin.from('agent_data_log').select('recorded_at, value').eq('org_id', orgId).eq('key', key).order('recorded_at', { ascending: false }).limit(limit);
          if (args.since) query = query.gte('recorded_at', String(args.since));
          const { data, error } = await query;
          if (error) return `ERROR: ${error.message}`;
          if (!data || data.length === 0) return `No hay entradas en data_log para key "${key}".`;
          const lines = (data as Array<{ recorded_at: string; value: string }>).map((r) => `${r.recorded_at.slice(0, 10)}: ${r.value}`).join('\n');
          return `${data.length} entradas para "${key}":\n${lines}`;
        }
        if (action === 'delete') {
          const { error } = await db.admin.from('agent_data_log').delete().eq('org_id', orgId).eq('key', key);
          if (error) return `ERROR: ${error.message}`;
          return `✅ Entradas de data_log eliminadas para key "${key}".`;
        }
        return 'ERROR: acción desconocida. Usa "write", "read" o "delete".';
      },
    },
    {
      name: 'schedule_job_manage',
      usage: 'schedule_job_manage{"action":"create|list|pause|resume|delete","title"?,"cron_expression"?,"description"?,"job_id"?}: programa o gestiona tareas recurrentes o recordatorios en background.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'pause', 'resume', 'delete'] },
          title: { type: 'string', description: 'Título del job recurrente.' },
          cron_expression: { type: 'string', description: 'Expresión cron estándar.' },
          description: { type: 'string', description: 'Qué debe hacer el job.' },
          job_id: { type: 'string', description: 'ID del job a pausar/reanudar/borrar.' },
        },
        required: ['action'],
      },
      execute: async (orgId, taskId, args) => {
        const action = String(args.action ?? '');
        const title = String(args.title ?? '').trim();
        const cron = String(args.cron_expression ?? '').trim();
        const description = String(args.description ?? '').trim();
        const jobId = String(args.job_id ?? '').trim();
        const { data: task } = await db.admin.from('tasks').select('created_by').eq('id', taskId).eq('org_id', orgId).maybeSingle();
        const userId = task?.created_by ?? 'system';
        if (action === 'create') {
          if (!title || !cron || !description) return 'ERROR: title, cron_expression y description requeridos para crear.';
          const job = await scheduledJobs.create({ name: title, schedule_type: 'cron', cron_expr: cron, task_input: description, job_type: 'custom' }, orgId, userId);
          return `✅ Job recurrente creado exitosamente con ID ${job.id} y cron "${job.cron_expr}"`;
        }
        if (action === 'list') {
          const list = await scheduledJobs.list(orgId);
          if (list.length === 0) return 'No tienes tareas programadas activas.';
          return list.map((j: any) => `[ID: ${j.id}] "${j.name}" — cron "${j.cron_expr}" (estado: ${j.status})`).join('\n');
        }
        if (action === 'pause') { if (!jobId) return 'ERROR: job_id requerido.'; await scheduledJobs.pause(jobId, orgId); return `✅ Job ${jobId} pausado.`; }
        if (action === 'resume') { if (!jobId) return 'ERROR: job_id requerido.'; await scheduledJobs.resume(jobId, orgId); return `✅ Job ${jobId} reanudado.`; }
        if (action === 'delete') { if (!jobId) return 'ERROR: job_id requerido.'; await scheduledJobs.delete(jobId, orgId); return `✅ Job ${jobId} eliminado de forma permanente.`; }
        return 'ERROR: acción desconocida.';
      },
    },
  ];
}

/** Zod schemas for arg validation — keyed by tool name. */
export function buildZodSchemas(): Record<string, z.ZodSchema> {
  return {
    web_search: z.object({ query: z.string().min(1, 'El query no puede estar vacío') }),
    gmail_read: z.object({ query: z.string().optional() }),
    calendar_read: z.object({ days: z.number().min(1).max(30).optional() }),
    drive_read: z.object({ query: z.string().min(1, 'El query no puede estar vacío') }),
    memory_recall: z.object({ query: z.string().min(1, 'El query no puede estar vacío') }),
    ask_user: z.object({
      question: z.string().min(1, 'La pregunta no puede estar vacía'),
      options: z.array(z.string()).optional(),
      timeout_minutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
    }),
    code_execute: z.object({
      language: z.enum(['python', 'node', 'bash']).optional(),
      code: z.string().min(1, 'El código no puede estar vacío'),
      network: z.boolean().optional(),
      session: z.number().int().min(0).max(9).optional(),
    }),
    terminal_run: z.object({
      cmd: z.string().min(1, 'El comando no puede estar vacío'),
      background: z.boolean().optional(),
      session: z.number().int().min(0).max(9).optional(),
    }),
    terminal_output: z.object({ session: z.number().int().min(0).max(9).optional() }),
    terminal_input: z.object({
      keyboard: z.string(),
      session: z.number().int().min(0).max(9).optional(),
    }),
    skill_run: z.object({ slug: z.string().min(1, 'El slug no puede estar vacío') }),
    skill_save: z.object({
      name: z.string().min(1, 'El nombre no puede estar vacío'),
      description: z.string().min(1, 'La descripción no puede estar vacía'),
      language: z.enum(['python', 'node', 'bash']).optional(),
      code: z.string().min(1, 'El código no puede estar vacío'),
    }),
    script_forge: z.object({ spec: z.string().min(1, 'El spec no puede estar vacío') }),
    delegate: z.object({ goal: z.string().min(1, 'El objetivo no puede estar vacío'), role: z.string().optional() }),
    image_analyze: z.object({ path: z.string().min(1, 'La ruta de la imagen no puede estar vacía'), prompt: z.string().optional() }),
    sandbox_ls: z.object({ path: z.string().optional() }),
    telegram_send_file: z.object({ file: z.string().min(1, 'El archivo no puede estar vacío'), caption: z.string().optional(), chat_id: z.string().optional() }),
    whatsapp_send: z.object({ contact: z.string().min(1, 'El contacto no puede estar vacío'), text: z.string().min(1, 'El texto no puede estar vacío') }),
    whatsapp_read: z.object({ contact: z.string().optional(), unread_only: z.boolean().optional(), unanswered_only: z.boolean().optional() }),
    uber_quote: z.object({ origin: z.string().min(1, 'El origen no puede estar vacío'), destination: z.string().min(1, 'El destino no puede estar vacío') }),
    uber_request_ride: z.object({ origin: z.string().min(1, 'El origen no puede estar vacío'), destination: z.string().min(1, 'El destino no puede estar vacío'), ride_type: z.string().optional() }),
    known_places_manage: z.object({ action: z.enum(['list', 'save']), label: z.string().optional(), address: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() }),
    uber_login: z.object({ email: z.string().email('Debe ser un correo válido'), password: z.string().optional() }),
    rappi_login: z.object({ email: z.string().email('Debe ser un correo válido') }),
    gmail_write: z.object({ action: z.enum(['send', 'reply', 'trash', 'archive', 'mark_read', 'mark_unread']), to: z.string().optional(), subject: z.string().optional(), body: z.string().optional(), message_id: z.string().optional() }),
    calendar_write: z.object({ action: z.enum(['create', 'delete']), summary: z.string().optional(), start_time: z.string().optional(), end_time: z.string().optional(), description: z.string().optional(), event_id: z.string().optional() }),
    schedule_job_manage: z.object({ action: z.enum(['create', 'list', 'pause', 'resume', 'delete']), title: z.string().optional(), cron_expression: z.string().optional(), description: z.string().optional(), job_id: z.string().optional() }),
  };
}
