import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ModelBudget } from '../model-router/model-router.types';

export type AgentTrajectoryOutcome = 'running' | 'ok' | 'failed' | 'degraded' | 'cancelled';

export interface ModelBudgetStep {
  step: number;
  budget: ModelBudget;
  reason: string;
  tool?: string;
}

export interface AgentTrajectoryStep {
  tool: string;
  args: Record<string, unknown>;
  thought: string;
  observation: string;
}

export interface AgentTrajectorySnapshot {
  orgId: string;
  taskId: string;
  goal: string;
  steps: AgentTrajectoryStep[];
  outcome: AgentTrajectoryOutcome;
  tokensUsed: number;
  toolsUsed: string[];
  depth: number;
  durationMs: number;
  stallCount: number;
  dodRejections: number;
  modelBudgetPerStep: ModelBudgetStep[];
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AgentTrajectoryService {
  private readonly logger = new Logger(AgentTrajectoryService.name);

  constructor(private readonly db: DatabaseService) {}

  async checkpoint(snapshot: AgentTrajectorySnapshot): Promise<void> {
    await this.upsert(snapshot, false);
  }

  async complete(snapshot: AgentTrajectorySnapshot): Promise<void> {
    await this.upsert(snapshot, true);
  }

  async metrics(orgId: string) {
    const [tools, goals, defenses, skills, efficiency] = await Promise.all([
      this.selectView('agent_tool_success_metrics', orgId),
      this.selectView('agent_goal_success_metrics', orgId),
      this.selectView('agent_defense_metrics', orgId),
      this.selectView('agent_skill_funnel_metrics', orgId),
      this.selectView('agent_task_efficiency_metrics', orgId),
    ]);
    return { tools, goals, defenses: defenses[0] ?? null, skills: skills[0] ?? null, efficiency: efficiency[0] ?? null };
  }

  private async upsert(snapshot: AgentTrajectorySnapshot, completed: boolean): Promise<void> {
    const payload = {
      org_id: snapshot.orgId,
      task_id: snapshot.taskId,
      goal: snapshot.goal,
      goal_key: this.goalKey(snapshot.goal),
      steps: snapshot.steps,
      outcome: snapshot.outcome,
      tokens_used: snapshot.tokensUsed,
      tools_used: snapshot.toolsUsed,
      depth: snapshot.depth,
      duration_ms: snapshot.durationMs,
      stall_count: snapshot.stallCount,
      dod_rejections: snapshot.dodRejections,
      model_budget_per_step: snapshot.modelBudgetPerStep,
      metadata: snapshot.metadata ?? {},
      completed_at: completed ? new Date().toISOString() : null,
    };

    const { error } = await this.db.admin
      .from('agent_trajectories')
      .upsert(payload, { onConflict: 'org_id,task_id' });

    if (error) {
      this.logger.debug(`trajectory upsert skipped: ${error.message}`);
    }
  }

  private async selectView(view: string, orgId: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.db.admin
      .from(view)
      .select('*')
      .eq('org_id', orgId);

    if (error) {
      this.logger.warn(`metrics view ${view} failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as Record<string, unknown>[];
  }

  private goalKey(goal: string): string {
    const lower = goal.toLowerCase();
    if (/\b(correo|email|gmail|inbox)\b/.test(lower)) return 'email';
    if (/\b(calendario|agenda|cita|evento)\b/.test(lower)) return 'calendar';
    if (/\b(drive|archivo|documento|sheet|carpeta)\b/.test(lower)) return 'drive';
    if (/\b(código|codigo|script|programa|debug|bug|test|prueba)\b/.test(lower)) return 'code';
    if (/\b(busca|internet|noticia|precio|clima|actual|hoy)\b/.test(lower)) return 'research';
    if (/\b(resume|analiza|compara|plan|estrategia)\b/.test(lower)) return 'reasoning';
    return 'general';
  }
}
