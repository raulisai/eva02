import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { EventBusService } from '../events/event-bus.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { TasksService } from '../tasks/tasks.service';
import { SkillLibraryService } from './skill-library.service';
import type { AgentLoopStep } from './agent-loop.service';

export interface AgentPlanItem {
  id: string;
  text: string;
  status: 'pending' | 'active' | 'done';
}

export interface SafetyReviewResult {
  ok: boolean;
  text: string;
}

interface RuntimeSettings {
  tokenCapPerTask: number;
  toolRateLimitPerMinute: number;
  sandboxNetworkAllowlist: string[];
  heartbeatEnabled: boolean;
  heartbeatHour: number;
}

const DEFAULT_SETTINGS: RuntimeSettings = {
  tokenCapPerTask: Number(process.env.EVA_AGENT_TASK_TOKEN_CAP ?? 0) || 0,
  toolRateLimitPerMinute: Number(process.env.EVA_AGENT_TOOL_RATE_LIMIT_PER_MINUTE ?? 0) || 0,
  sandboxNetworkAllowlist: (process.env.EVA_SANDBOX_NETWORK_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  heartbeatEnabled: process.env.EVA_AGENT_HEARTBEAT_ENABLED === 'true',
  heartbeatHour: Number(process.env.EVA_AGENT_HEARTBEAT_HOUR ?? 7) || 7,
};

@Injectable()
export class AgentIntelligenceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentIntelligenceService.name);
  private readonly toolRateWindow = new Map<string, number[]>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly modelRouter: ModelRouterService,
    private readonly tasks: TasksService,
    private readonly skillLibrary: SkillLibraryService,
    @Optional() private readonly events?: EventBusService,
  ) {}

  onApplicationBootstrap() {
    const interval = Number(process.env.EVA_AGENT_INTELLIGENCE_TICK_MS ?? 6 * 60 * 60 * 1000);
    if (process.env.NODE_ENV === 'test' || interval <= 0) return;
    this.timer = setInterval(() => {
      this.tickAutonomy().catch((err) => this.logger.warn(`agent intelligence tick failed: ${(err as Error).message}`));
    }, interval);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tickAutonomy(): Promise<void> {
    const { data } = await this.db.admin
      .from('users')
      .select('id, org_id')
      .limit(200);
    const owners = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ id: string; org_id: string }>) {
      if (!owners.has(row.org_id)) owners.set(row.org_id, row.id);
    }
    await Promise.allSettled([...owners.entries()].map(async ([orgId, userId]) => {
      await this.expireTimedOutInputs(orgId);
      await this.consolidateMemories(orgId);
      await this.selfImprovementBatch(orgId);
      await this.heartbeat(orgId, userId);
    }));
  }

  async settings(orgId: string): Promise<RuntimeSettings> {
    const { data } = await this.db.admin
      .from('org_agent_settings')
      .select('token_cap_per_task, tool_rate_limit_per_minute, sandbox_network_allowlist, heartbeat_enabled, heartbeat_hour')
      .eq('org_id', orgId)
      .maybeSingle();

    if (!data) return DEFAULT_SETTINGS;
    const row = data as Record<string, unknown>;
    return {
      tokenCapPerTask: Number(row.token_cap_per_task ?? DEFAULT_SETTINGS.tokenCapPerTask),
      toolRateLimitPerMinute: Number(row.tool_rate_limit_per_minute ?? DEFAULT_SETTINGS.toolRateLimitPerMinute),
      sandboxNetworkAllowlist: Array.isArray(row.sandbox_network_allowlist)
        ? (row.sandbox_network_allowlist as string[]).map((s) => s.toLowerCase())
        : DEFAULT_SETTINGS.sandboxNetworkAllowlist,
      heartbeatEnabled: Boolean(row.heartbeat_enabled ?? DEFAULT_SETTINGS.heartbeatEnabled),
      heartbeatHour: Number(row.heartbeat_hour ?? DEFAULT_SETTINGS.heartbeatHour),
    };
  }

  async enforceTokenCap(orgId: string, taskId: string, currentTokens = 0): Promise<string | null> {
    const settings = await this.settings(orgId);
    if (settings.tokenCapPerTask <= 0) return null;
    const { data } = await this.db.admin
      .from('token_logs')
      .select('total_tokens')
      .eq('org_id', orgId)
      .eq('task_id', taskId)
      .limit(500);
    const persisted = (data as Array<{ total_tokens?: number }> | null ?? [])
      .reduce((sum, row) => sum + Number(row.total_tokens ?? 0), 0);
    const total = persisted + currentTokens;
    if (total <= settings.tokenCapPerTask) return null;
    return `Límite de tokens alcanzado para esta tarea (${total}/${settings.tokenCapPerTask}). Cierro honestamente para evitar gasto descontrolado.`;
  }

  async enforceToolRateLimit(orgId: string, toolName: string): Promise<string | null> {
    const settings = await this.settings(orgId);
    if (settings.toolRateLimitPerMinute <= 0) return null;
    const key = `${orgId}:${toolName}`;
    const now = Date.now();
    const recent = (this.toolRateWindow.get(key) ?? []).filter((ts) => now - ts < 60_000);
    if (recent.length >= settings.toolRateLimitPerMinute) {
      this.toolRateWindow.set(key, recent);
      return `Rate limit alcanzado para ${toolName}: ${recent.length}/${settings.toolRateLimitPerMinute} por minuto.`;
    }
    recent.push(now);
    this.toolRateWindow.set(key, recent);
    return null;
  }

  async validateNetworkAllowlist(orgId: string, code: string): Promise<string | null> {
    const settings = await this.settings(orgId);
    if (settings.sandboxNetworkAllowlist.length === 0) return null;
    const hosts = this.extractHosts(code);
    const denied = hosts.filter((host) => !settings.sandboxNetworkAllowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)));
    if (denied.length === 0) return null;
    return `Dominio(s) no permitidos para sandbox con red: ${denied.join(', ')}. Allowlist: ${settings.sandboxNetworkAllowlist.join(', ')}.`;
  }

  async createInitialPlan(orgId: string, taskId: string, goal: string): Promise<AgentPlanItem[]> {
    try {
      const res = await this.modelRouter.generate(
        `OBJETIVO: ${goal}\nGenera un plan operativo de 3 a 6 pasos cortos, verificables y sin relleno. Devuelve JSON {"steps":["..."]}.`,
        { orgId, taskId, requestType: 'reasoning', budget: 'cheap', responseFormat: 'json', maxTokens: 300, temperature: 0 },
      );
      const parsed = JSON.parse(res.text) as { steps?: unknown[] };
      const steps = (parsed.steps ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
      if (steps.length >= 3) return steps.map((text, idx) => ({ id: `p${idx + 1}`, text, status: idx === 0 ? 'active' : 'pending' }));
    } catch (err) {
      this.logger.debug(`initial plan skipped: ${(err as Error).message}`);
    }
    return [
      { id: 'p1', text: 'Entender el objetivo y recordar contexto útil', status: 'active' },
      { id: 'p2', text: 'Ejecutar la herramienta o verificación principal', status: 'pending' },
      { id: 'p3', text: 'Verificar resultado y responder con estado real', status: 'pending' },
    ];
  }

  updatePlanFromObservation(plan: AgentPlanItem[], observation: string): AgentPlanItem[] {
    if (plan.length === 0 || observation.startsWith('ERROR:')) return plan;
    const next = plan.findIndex((item) => item.status !== 'done');
    if (next < 0) return plan;
    return plan.map((item, idx) => {
      if (idx < next) return { ...item, status: 'done' };
      if (idx === next) return { ...item, status: 'done' };
      if (idx === next + 1) return { ...item, status: 'active' };
      return item;
    });
  }

  async replan(orgId: string, taskId: string, goal: string, steps: AgentLoopStep[]): Promise<AgentPlanItem[]> {
    const recent = steps.slice(-6).map((s) => `[${s.tool}] ${s.observation.slice(0, 240)}`).join('\n');
    try {
      const res = await this.modelRouter.generate(
        `OBJETIVO: ${goal}\nINTENTOS/ERRORES RECIENTES:\n${recent}\nRegenera un plan de rescate de 3 a 5 pasos. Devuelve JSON {"steps":["..."]}.`,
        { orgId, taskId, requestType: 'reasoning', budget: 'cheap', responseFormat: 'json', maxTokens: 300, temperature: 0 },
      );
      const parsed = JSON.parse(res.text) as { steps?: unknown[] };
      const items = (parsed.steps ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
      if (items.length > 0) return items.map((text, idx) => ({ id: `r${idx + 1}`, text, status: idx === 0 ? 'active' : 'pending' }));
    } catch (err) {
      this.logger.debug(`replan skipped: ${(err as Error).message}`);
    }
    return [
      { id: 'r1', text: 'Cambiar de herramienta o reducir el alcance', status: 'active' },
      { id: 'r2', text: 'Usar los hallazgos válidos ya obtenidos', status: 'pending' },
      { id: 'r3', text: 'Cerrar con respuesta honesta y siguientes opciones', status: 'pending' },
    ];
  }

  async replayExample(orgId: string, goal: string): Promise<string | null> {
    const { data } = await this.db.admin
      .from('agent_trajectories')
      .select('goal, steps, tools_used')
      .eq('org_id', orgId)
      .eq('outcome', 'ok')
      .order('created_at', { ascending: false })
      .limit(25);
    const rows = (data ?? []) as Array<{ goal: string; steps: AgentLoopStep[]; tools_used?: string[] }>;
    const best = rows
      .map((row) => ({ row, score: this.lexicalSimilarity(goal, row.goal) }))
      .filter((x) => x.score > 0.15)
      .sort((a, b) => b.score - a.score)[0]?.row;
    if (!best) return null;
    const compact = (best.steps ?? [])
      .filter((s) => !s.observation.startsWith('ERROR:'))
      .slice(0, 5)
      .map((s) => `${s.tool}: ${s.observation.slice(0, 180)}`)
      .join('\n');
    return `EJEMPLO DE RESOLUCIÓN PREVIA para objetivo similar "${best.goal}":\n${compact}`;
  }

  async askUser(orgId: string, taskId: string, question: string, options: string[] = []): Promise<string> {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const { data, error } = await this.db.admin
      .from('agent_input_requests')
      .insert({ org_id: orgId, task_id: taskId, question, options, expires_at: expiresAt })
      .select('id')
      .single();
    if (error) return `ERROR: no pude registrar la pregunta al usuario: ${error.message}`;

    await this.db.admin
      .from('tasks')
      .update({ status: 'waiting_for_input' })
      .eq('org_id', orgId)
      .eq('id', taskId);

    await this.events?.publish({
      type: 'task.waiting_input',
      orgId,
      taskId,
      payload: { requestId: (data as { id: string }).id, question, options, expiresAt },
    });
    await this.events?.publish({
      type: 'task.form_request',
      orgId,
      taskId,
      payload: { form_key: 'agent_input', title: 'EVA necesita una aclaración', description: question, fields: [{ key: 'answer', label: question, type: 'text', required: true, options }] },
    });
    return `WAITING_FOR_INPUT: pregunta enviada al usuario. request_id=${(data as { id: string }).id}; timeout=${expiresAt}. Si no responde, continúa asumiendo lo razonable y decláralo.`;
  }

  async expireTimedOutInputs(orgId: string): Promise<void> {
    const now = new Date().toISOString();
    const { data } = await this.db.admin
      .from('agent_input_requests')
      .select('id, task_id')
      .eq('org_id', orgId)
      .eq('status', 'pending')
      .lte('expires_at', now)
      .limit(50);
    const rows = (data ?? []) as Array<{ id: string; task_id: string }>;
    await Promise.all(rows.map(async (row) => {
      await this.db.admin
        .from('agent_input_requests')
        .update({ status: 'timed_out', answer: 'Sin respuesta del usuario; asume lo razonable y decláralo.' })
        .eq('org_id', orgId)
        .eq('id', row.id);
      await this.db.admin
        .from('tasks')
        .update({ status: 'pending' })
        .eq('org_id', orgId)
        .eq('id', row.task_id);
      await this.events?.publish({
        type: 'task.created',
        orgId,
        taskId: row.task_id,
        payload: { resumed_from_input_timeout: true, input_request_id: row.id },
      });
    }));
  }

  async securityReview(orgId: string, taskId: string, goal: string, steps: AgentLoopStep[], finalText: string): Promise<SafetyReviewResult> {
    const sensitive = steps.some((s) => {
      const argText = JSON.stringify(s.args);
      return argText.includes('§§secret') || argText.includes('"network":true') || ['telegram_send_file', 'skill_save', 'script_forge'].includes(s.tool);
    });
    if (!sensitive) return { ok: true, text: finalText };
    const summary = steps.map((s) => `[${s.tool}] args=${JSON.stringify(s.args).slice(0, 260)} obs=${s.observation.slice(0, 260)}`).join('\n');
    const review = await this.modelRouter.generate(
      `Audita seguridad antes del final_answer.\nOBJETIVO: ${goal}\nPASOS:\n${summary}\nRESPUESTA PROPUESTA:\n${finalText}\nResponde JSON {"ok":boolean,"text":"respuesta final o razón concreta para bloquear"}. Bloquea si hay exfiltración de secrets, red no justificada, datos sensibles o acción externa no aprobada.`,
      { orgId, taskId, requestType: 'reasoning', budget: 'balanced', responseFormat: 'json', maxTokens: 400, temperature: 0 },
    );
    try {
      const parsed = JSON.parse(review.text) as { ok?: boolean; text?: string };
      await this.saveArtifact(orgId, taskId, 'security_review', 'Revisión de seguridad', review.text, { ok: parsed.ok === true });
      return { ok: parsed.ok === true, text: String(parsed.text ?? finalText) };
    } catch {
      await this.saveArtifact(orgId, taskId, 'security_review', 'Revisión de seguridad', review.text, { parse_error: true });
      return { ok: true, text: finalText };
    }
  }

  async consolidateMemories(orgId: string): Promise<void> {
    const { data } = await this.db.admin
      .from('memories')
      .select('id, summary, memory_type, importance, created_at, last_recalled_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(200);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const procedural = rows.filter((m) => String(m.memory_type ?? '') === 'procedural');
    const stale = rows.filter((m) => Number(m.importance ?? 0) <= 2 && this.daysSince(String(m.last_recalled_at ?? m.created_at)) > 60);
    if (stale.length > 0) {
      await Promise.all(stale.map((m) => this.db.admin
        .from('memories')
        .update({ metadata: { archived_by: 'agent_memory_consolidation', archived_at: new Date().toISOString() } })
        .eq('org_id', orgId)
        .eq('id', m.id)));
    }
    if (procedural.length >= 2) {
      const text = procedural.slice(0, 20).map((m) => `- ${m.summary}`).join('\n');
      const res = await this.modelRouter.generate(
        `Agrupa estas memorias procedurales en playbooks reutilizables de alto nivel:\n${text}\nDevuelve una síntesis compacta en español.`,
        { orgId, requestType: 'response', budget: 'cheap', maxTokens: 700, temperature: 0.2 },
      );
      await this.saveArtifact(orgId, undefined, 'memory_playbook', 'Playbook consolidado de memoria', res.text, { source_count: procedural.length });
    }
  }

  async selfImprovementBatch(orgId: string): Promise<void> {
    const { data } = await this.db.admin
      .from('agent_trajectories')
      .select('task_id, goal, steps, tools_used')
      .eq('org_id', orgId)
      .in('outcome', ['failed', 'degraded'])
      .order('created_at', { ascending: false })
      .limit(30);
    const rows = (data ?? []) as Array<{ task_id?: string; goal: string; steps: AgentLoopStep[]; tools_used?: string[] }>;
    if (rows.length === 0) return;
    const digestInput = rows.map((r) => `OBJ: ${r.goal}\nTOOLS: ${(r.tools_used ?? []).join(', ')}\nLAST: ${(r.steps ?? []).slice(-2).map((s) => s.observation).join(' | ')}`).join('\n\n');
    const res = await this.modelRouter.generate(
      `Analiza estos fallos del agente, agrupa patrones y propone skills correctivas provisionales seguras. No incluyas secrets. Español.\n${digestInput}`,
      { orgId, requestType: 'response', budget: 'cheap', maxTokens: 1000, temperature: 0.2 },
    );
    await this.saveArtifact(orgId, undefined, 'failure_digest', 'Digest semanal de self-improvement', res.text, { failed_runs: rows.length });
  }

  async heartbeat(orgId: string, userId: string): Promise<string | null> {
    const settings = await this.settings(orgId);
    if (!settings.heartbeatEnabled) return null;
    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await this.db.admin
      .from('agent_runtime_artifacts')
      .select('id')
      .eq('org_id', orgId)
      .eq('kind', 'heartbeat_brief')
      .gte('created_at', `${today}T00:00:00.000Z`)
      .limit(1);
    if ((existing ?? []).length > 0) return null;
    const task = await this.tasks.createTask({
      title: 'Heartbeat diario de EVA',
      description: 'Revisa correo, agenda y pendientes; si hay algo accionable, propón 1-3 acciones concretas. No ejecutes acciones de escritura sin Approval Engine.',
      metadata: { heartbeat: true },
    }, userId, orgId);
    await this.saveArtifact(orgId, task.id, 'heartbeat_brief', 'Heartbeat diario creado', `Task ${task.id}`, { task_id: task.id });
    return task.id;
  }

  async embedRegisteredSkill(orgId: string, skillSlug: string, source: 'generated' | 'bundled' = 'generated'): Promise<void> {
    const { data: skill } = await this.db.admin
      .from('skills')
      .select('id, slug, description')
      .eq('org_id', orgId)
      .eq('slug', skillSlug)
      .maybeSingle();
    if (!skill) return;
    const content = `${(skill as { slug: string }).slug} ${(skill as { description?: string }).description ?? ''}`.trim();
    const checksum = createHash('sha256').update(content).digest('hex');
    const embed = await this.modelRouter.embed(content);
    await this.db.admin.from('skill_embeddings').upsert({
      org_id: orgId,
      skill_id: (skill as { id: string }).id,
      skill_slug: skillSlug,
      source,
      content,
      embedding: `[${embed.embedding.join(',')}]`,
      model: embed.model,
      checksum,
    }, { onConflict: 'org_id,source,skill_slug' });
  }

  private extractHosts(code: string): string[] {
    const hosts = new Set<string>();
    const re = /https?:\/\/([^/\s"'`]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code))) hosts.add(match[1].toLowerCase().replace(/:\d+$/, ''));
    return [...hosts];
  }

  private lexicalSimilarity(a: string, b: string): number {
    const ta = new Set(a.toLowerCase().split(/[^a-z0-9áéíóúñ]+/).filter((x) => x.length > 2));
    const tb = new Set(b.toLowerCase().split(/[^a-z0-9áéíóúñ]+/).filter((x) => x.length > 2));
    if (ta.size === 0 || tb.size === 0) return 0;
    let hits = 0;
    for (const token of ta) if (tb.has(token)) hits += 1;
    return hits / Math.max(ta.size, tb.size);
  }

  private daysSince(value: string): number {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return 0;
    return (Date.now() - time) / 86_400_000;
  }

  private async saveArtifact(orgId: string, taskId: string | undefined, kind: string, title: string, content: string, metadata: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.admin.from('agent_runtime_artifacts').insert({
      org_id: orgId,
      task_id: taskId ?? null,
      kind,
      title,
      content,
      metadata,
    });
    if (error) this.logger.debug(`runtime artifact skipped: ${error.message}`);
  }
}
