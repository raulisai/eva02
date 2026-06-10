import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventBusService, EvaEvent } from '../events/event-bus.service';
import { TasksService } from './tasks.service';
import { TasksRepository } from './tasks.repository';
import { IntentRouterService } from '../intent-router/intent-router.service';
import { PlannerService } from '../planner/planner.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { AppGateway } from '../gateway/app.gateway';
import { Task } from './task.types';

const FAST_PATH_SYSTEM_PROMPT = `Eres Eva, un asistente de IA. Responde de forma útil y concisa.
Si te preguntan sobre información en tiempo real (clima, cotizaciones, noticias), indica amablemente
que no tienes acceso a datos en tiempo real y ofrece contexto o consejos relevantes.
Responde siempre en el mismo idioma que el usuario.`;

@Injectable()
export class TaskEngineService implements OnModuleInit {
  private readonly logger = new Logger(TaskEngineService.name);

  constructor(
    private readonly events: EventBusService,
    private readonly tasksService: TasksService,
    private readonly tasksRepo: TasksRepository,
    private readonly intentRouter: IntentRouterService,
    private readonly planner: PlannerService,
    private readonly modelRouter: ModelRouterService,
    private readonly gateway: AppGateway,
  ) {}

  async onModuleInit() {
    this.events.on('task.created', (e) =>
      this.handleTaskCreated(e as EvaEvent<{ taskId: string }>),
    );

    if (process.env.NODE_ENV !== 'test') {
      await this.events.startConsuming('task-engine-1');
      this.logger.log('Task engine started — consuming eva:events');
    }
  }

  // ── Event handler ──────────────────────────────────────────────────────────

  private async handleTaskCreated(event: EvaEvent<{ taskId: string }>) {
    const { taskId } = event.payload;
    const { orgId } = event;

    this.logger.log(`Processing task ${taskId}`);

    try {
      const task = await this.tasksService.getTask(taskId, orgId);

      // pending → planning
      await this.tasksService.transition(taskId, orgId, 'planning');
      this.broadcastUpdate(orgId, taskId, 'Analizando tu solicitud...');

      const goal = (task.title ?? task.description ?? '').trim() || 'tarea';
      const { intent } = await this.intentRouter.classify(goal, orgId, { taskId });

      if (intent === 'fast_path') {
        await this.runFastPath(task, goal, orgId);
      } else {
        await this.runCorePath(task, goal, orgId, intent === 'core_path_approval');
      }
    } catch (err) {
      this.logger.error(`Task ${taskId} failed`, err);
      try {
        const t = await this.tasksService.getTask(taskId, orgId).catch(() => null);
        if (t && !['completed', 'failed', 'cancelled'].includes(t.status)) {
          await this.tasksRepo.updateStatus(taskId, orgId, 'failed', {
            error: (err as Error).message,
            completed_at: new Date().toISOString(),
          });
          this.broadcastUpdate(orgId, taskId, `Error: ${(err as Error).message}`);
        }
      } catch (inner) {
        this.logger.error(`Failed to mark task ${taskId} as failed`, inner);
      }
    }
  }

  // ── Fast path: single LLM call ─────────────────────────────────────────────

  private async runFastPath(task: Task, goal: string, orgId: string) {
    const taskId = task.id;

    await this.tasksService.transition(taskId, orgId, 'running');
    this.broadcastUpdate(orgId, taskId, 'Déjame revisar eso...');

    const result = await this.modelRouter.generate(goal, {
      systemPrompt: FAST_PATH_SYSTEM_PROMPT,
      budget: 'cheap',
      temperature: 0.7,
    });

    await this.tasksRepo.updateStatus(taskId, orgId, 'completed', {
      result: { text: result.text, model: result.model, tokens: result.usage.totalTokens },
      completed_at: new Date().toISOString(),
    });

    this.gateway.emitToOrg(orgId, {
      type: 'task.completed',
      orgId,
      taskId,
      payload: { taskId, result: result.text, model: result.model },
      ts: Date.now(),
    });

    this.logger.log(`Task ${taskId} completed (fast_path) via ${result.model}`);
  }

  // ── Core path: plan + execute steps ───────────────────────────────────────

  private async runCorePath(
    task: Task,
    goal: string,
    orgId: string,
    _needsApproval: boolean,
  ) {
    const taskId = task.id;

    this.broadcastUpdate(orgId, taskId, 'Generando plan de ejecución...');
    const plan = await this.planner.plan({ goal, orgId });

    await this.tasksService.transition(taskId, orgId, 'running');

    const stepResults: string[] = [];

    for (const step of plan.steps) {
      if (step.requires_approval) {
        await this.tasksService.transition(taskId, orgId, 'waiting_for_approval');
        this.broadcastUpdate(
          orgId, taskId,
          `Paso ${step.step} requiere aprobación: ${step.description}`,
        );
        return; // resumed by approvals engine
      }

      this.broadcastUpdate(orgId, taskId, `Paso ${step.step}: ${step.description}`);

      const stepResult = await this.modelRouter.generate(
        `Ejecuta el siguiente paso para lograr el objetivo.\n\nObjetivo: ${goal}\nPaso: ${step.description}\nHerramienta: ${step.tool}`,
        { budget: 'balanced', temperature: 0.4 },
      );
      stepResults.push(stepResult.text);
    }

    const summary = stepResults.at(-1) ?? 'Completado';

    await this.tasksRepo.updateStatus(taskId, orgId, 'completed', {
      result: { summary, steps: plan.steps.length, plan },
      completed_at: new Date().toISOString(),
    });

    this.gateway.emitToOrg(orgId, {
      type: 'task.completed',
      orgId,
      taskId,
      payload: { taskId, result: summary, steps: plan.steps.length },
      ts: Date.now(),
    });

    this.logger.log(`Task ${taskId} completed (core_path) in ${plan.steps.length} steps`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private broadcastUpdate(orgId: string, taskId: string, message: string) {
    this.gateway.emitToOrg(orgId, {
      type: 'task.update',
      orgId,
      taskId,
      payload: { taskId, message },
      ts: Date.now(),
    });
  }
}
