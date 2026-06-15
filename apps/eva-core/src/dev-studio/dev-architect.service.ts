import { Injectable, Logger } from '@nestjs/common';
import { ModelRouterService } from '../model-router/model-router.service';
import { DevSession, DevGoal, DevIteration, AGENT_SYSTEM_PROMPTS, SuccessCriterion } from './dev-studio.types';

export interface TechnicalTask {
  title: string;
  prompt: string;
  role: 'frontend' | 'backend' | 'testing' | 'deployment' | 'reviewer';
  priority: number;
  dependsOn: string[];
  acceptanceCriteria: SuccessCriterion[];
  branchName: string;
  riskLevel?: 'low' | 'medium' | 'high';
  requiresHumanApproval?: boolean;
}

interface ArchitectPlan {
  tasks: TechnicalTask[];
  architectureNotes?: string;
  risks?: string[];
  humanApprovalRequired?: boolean;
  humanApprovalReason?: string;
}

const TASK_DERIVATION_SYSTEM = `${AGENT_SYSTEM_PROMPTS.architect}

Tu tarea ahora es: dado un goal de producto y el objetivo de una iteración, genera las tareas técnicas concretas que los agentes especializados deben ejecutar.

Reglas:
- Genera 2-6 tareas técnicas por iteración.
- Cada tarea debe tener UN objetivo atómico y verificable.
- Asigna el rol correcto: frontend, backend, testing, deployment, reviewer.
- Si una tarea depende de otra, inclúyela en dependsOn (usa el índice 0-based).
- Cada branch_name debe ser: agent/<role>/iter-N-<slug>.
- Si algo toca auth, DB schema, multi-tenant, costos o deploy producción → humanApprovalRequired: true.
- Los acceptance_criteria deben ser verificables (no "que funcione", sino "el endpoint retorna 200 con campo X").

Responde SOLO en JSON:
{
  "tasks": [
    {
      "title": "Nombre corto de la tarea",
      "prompt": "Descripción completa de lo que el agente debe hacer, con contexto suficiente para ejecutar sin preguntas adicionales.",
      "role": "backend",
      "priority": 80,
      "dependsOn": [],
      "acceptanceCriteria": [
        {"id": "ac-0-1", "description": "El endpoint POST /products retorna 201 con el producto creado", "verifiable": true}
      ],
      "branchName": "agent/backend/iter-1-create-products",
      "riskLevel": "low",
      "requiresHumanApproval": false
    }
  ],
  "architectureNotes": "Notas relevantes sobre decisiones de arquitectura tomadas",
  "risks": ["Riesgo potencial 1"],
  "humanApprovalRequired": false,
  "humanApprovalReason": null
}`;

@Injectable()
export class DevArchitectService {
  private readonly logger = new Logger(DevArchitectService.name);

  constructor(private readonly modelRouter: ModelRouterService) {}

  async deriveTasks(
    session: DevSession,
    goal: DevGoal,
    iteration: DevIteration,
  ): Promise<ArchitectPlan> {
    const successCriteria = (goal.success_criteria as SuccessCriterion[]) ?? [];
    const missingCriteria = successCriteria.filter((c) => !c.verified);

    const prompt = `
Proyecto: "${session.title}"
North Star: ${session.north_star ?? 'N/A'}

Goal actual: "${goal.title}"
Descripción del goal: ${goal.description ?? 'N/A'}

Criterios de éxito del goal:
${successCriteria.map((c) => `- [${c.id}] ${c.description} ${c.verified ? '(✓ COMPLETADO)' : '(⬜ PENDIENTE)'}`).join('\n')}

Iteración actual: "${iteration.title}" (#{iteration.number})
Objetivo de esta iteración: ${iteration.objective}
Outputs planeados:
${(iteration.planned_outputs ?? []).map((o) => `- ${o}`).join('\n') || '- (definir en esta planificación)'}

Criterios faltantes a atacar:
${missingCriteria.map((c) => `- [${c.id}] ${c.description}`).join('\n') || '- (ver objetivo de la iteración)'}

Stack del proyecto: ${JSON.stringify(session.metadata?.stack ?? 'No definido')}

Genera las tareas técnicas para esta iteración.`.trim();

    try {
      const result = await this.modelRouter.generate(prompt, {
        orgId: session.org_id,
        budget: 'balanced',
        systemPrompt: TASK_DERIVATION_SYSTEM,
        responseFormat: 'json',
        temperature: 0.2,
      });

      const raw = result.text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(raw) as ArchitectPlan;

      if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
        throw new Error('No tasks generated');
      }

      // Sanitize and enrich tasks
      parsed.tasks = parsed.tasks.map((t, i) => ({
        ...t,
        priority: t.priority ?? (100 - i * 10),
        dependsOn: (t.dependsOn ?? []).map((dep) => typeof dep === 'number' ? `task-${dep}` : String(dep)),
        acceptanceCriteria: (t.acceptanceCriteria ?? []).map((c, ci) => ({
          id: (c as SuccessCriterion).id ?? `ac-${i}-${ci}`,
          description: (c as SuccessCriterion).description ?? String(c),
          verifiable: (c as SuccessCriterion).verifiable ?? true,
        })),
        branchName: t.branchName ?? `agent/${t.role}/iter-${iteration.number ?? 1}-task-${i}`,
      }));

      return parsed;
    } catch (err) {
      this.logger.warn(`Architect deriveTasks fallback: ${(err as Error).message}`);
      // Fallback minimal plan
      return {
        tasks: [
          {
            title: `Implementar objetivo: ${iteration.objective.slice(0, 60)}`,
            prompt: `${iteration.objective}\n\nContexto del goal: ${goal.description ?? goal.title}\n\nCriterios de aceptación:\n${missingCriteria.map((c) => `- ${c.description}`).join('\n')}`,
            role: 'backend',
            priority: 100,
            dependsOn: [],
            acceptanceCriteria: missingCriteria.slice(0, 3).map((c) => ({ ...c, verifiable: true })),
            branchName: `agent/backend/iter-${iteration.number ?? 1}-main`,
            riskLevel: 'medium' as const,
            requiresHumanApproval: false,
          },
          {
            title: `Testing: ${goal.title.slice(0, 50)}`,
            prompt: `Crea tests para los cambios de la tarea principal de la iteración ${iteration.number ?? 1}. Valida los criterios de aceptación del goal.`,
            role: 'testing',
            priority: 50,
            dependsOn: ['task-0'],
            acceptanceCriteria: [
              {
                id: 'ac-test-1',
                description: 'Los tests cubren los criterios de aceptación del goal',
                verifiable: true,
              },
            ],
            branchName: `agent/testing/iter-${iteration.number ?? 1}-tests`,
            riskLevel: 'low' as const,
            requiresHumanApproval: false,
          },
        ],
        architectureNotes: 'Plan de fallback generado automáticamente.',
        risks: [],
        humanApprovalRequired: false,
      };
    }
  }

  buildBranchName(role: string, sessionId: string, iterationNumber: number, taskSlug: string): string {
    const sessionShort = sessionId.slice(0, 8);
    const slug = taskSlug.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 30);
    return `agent/${role}/s${sessionShort}-i${iterationNumber}-${slug}`;
  }
}
