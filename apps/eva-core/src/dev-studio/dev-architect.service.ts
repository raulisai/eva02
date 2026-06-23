import { Injectable, Logger } from '@nestjs/common';
import { ModelRouterService } from '../model-router/model-router.service';
import { DevSession, DevGoal, DevIteration, AGENT_SYSTEM_PROMPTS, SuccessCriterion, TeamTier, TEAM_TIER_CONFIG } from './dev-studio.types';
import { extractJson } from './dev-studio.utils';

export interface TechnicalTask {
  title: string;
  prompt: string;
  role: 'frontend' | 'backend' | 'full_stack' | 'testing' | 'deployment' | 'reviewer';
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

const TASK_DERIVATION_BASE = `${AGENT_SYSTEM_PROMPTS.architect}

Tu tarea ahora es: dado un goal de producto y el objetivo de una iteración, genera las tareas técnicas concretas que los agentes especializados deben ejecutar.

## Reglas generales
- Cada tarea debe tener UN objetivo atómico y verificable.
- Si una tarea depende de otra, inclúyela en dependsOn (usa el índice 0-based como "task-N").
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

/**
 * Builds the Architect's task-derivation system prompt, injecting the team
 * tier constraints so the LLM only assigns roles the session is allowed to use.
 */
function buildTaskDerivationSystem(tier: TeamTier): string {
  const config = TEAM_TIER_CONFIG[tier];
  const rolesStr = config.availableRoles.join(', ');

  const tierInstructions: Record<TeamTier, string> = {
    small: `## Tier del proyecto: SMALL — ${config.description}
Roles técnicos disponibles: ${rolesStr}
Límite de tareas por iteración: ${config.maxTasksPerIteration}

Reglas de equipo para proyectos SMALL:
- Usa preferentemente "full_stack" si el proyecto mezcla servidor y UI.
- Usa "backend" si es puramente lógica de servidor, juego, script o CLI.
- Usa "frontend" si es puramente UI estática o presentacional.
- NUNCA uses testing, reviewer, deployment ni full_stack + backend + frontend juntos.
- Para proyectos simples UNA sola tarea es correcto y suficiente.
- Máximo 2 tareas: si necesitas más, estás sobrediseñando para el scope.`,

    medium: `## Tier del proyecto: MEDIUM — ${config.description}
Roles técnicos disponibles: ${rolesStr}
Límite de tareas por iteración: ${config.maxTasksPerIteration}

Reglas de equipo para proyectos MEDIUM:
- Separa "frontend" y "backend" solo cuando tengan trabajo genuinamente paralelo e independiente.
- Si la iteración mezcla ambos lados sin mucho paralelismo, usa "full_stack".
- Añade "testing" solo cuando haya lógica compleja, flujos de auth, o criterios que exigen tests automatizados.
- NUNCA uses reviewer ni deployment en este tier (no hay code review formal ni pipeline de producción).
- Máximo 4 tareas; si necesitas más, el scope de la iteración es demasiado grande.`,

    large: `## Tier del proyecto: LARGE — ${config.description}
Roles técnicos disponibles: ${rolesStr}
Límite de tareas por iteración: ${config.maxTasksPerIteration}

Reglas de equipo para proyectos LARGE:
- Separa siempre "frontend" y "backend" en tareas independientes.
- "testing" SIEMPRE presente para validar integraciones y flujos críticos.
- Añade "reviewer" cuando haya múltiples outputs de distintos roles que deben integrarse.
- Añade "deployment" solo si el objetivo explícito de la iteración incluye despliegue o CI/CD.
- NUNCA uses "full_stack" en proyectos large (la especialización es obligatoria).
- Máximo 6 tareas por iteración.`,
  };

  return `${TASK_DERIVATION_BASE}\n\n${tierInstructions[tier]}`;
}

@Injectable()
export class DevArchitectService {
  private readonly logger = new Logger(DevArchitectService.name);

  constructor(private readonly modelRouter: ModelRouterService) {}

  async deriveTasks(
    session: DevSession,
    goal: DevGoal,
    iteration: DevIteration,
    teamTier: TeamTier = 'medium',
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

Iteración actual: "${iteration.title}" (#${iteration.number})
Objetivo de esta iteración: ${iteration.objective}
Outputs planeados:
${(iteration.planned_outputs ?? []).map((o) => `- ${o}`).join('\n') || '- (definir en esta planificación)'}

Criterios faltantes a atacar:
${missingCriteria.map((c) => `- [${c.id}] ${c.description}`).join('\n') || '- (ver objetivo de la iteración)'}

Stack del proyecto: ${JSON.stringify(session.metadata?.stack ?? 'No definido')}

Genera las tareas técnicas para esta iteración.`.trim();

    const systemPrompt = buildTaskDerivationSystem(teamTier);
    const tierConfig = TEAM_TIER_CONFIG[teamTier];

    try {
      const result = await this.modelRouter.generate(prompt, {
        orgId: session.org_id,
        budget: 'balanced',
        systemPrompt,
        responseFormat: 'json',
        temperature: 0.2,
        maxTokens: 4096,
      });

      const parsed = extractJson<ArchitectPlan>(result.text);

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

      // Guard: remove any tasks with roles outside the tier's allowed set
      const allowedRoles = new Set(tierConfig.availableRoles);
      const invalidTasks = parsed.tasks.filter((t) => !allowedRoles.has(t.role));
      if (invalidTasks.length > 0) {
        this.logger.warn(
          `Architect assigned roles outside tier "${teamTier}": ${invalidTasks.map((t) => t.role).join(', ')}. Remapping to safe fallback.`,
        );
        parsed.tasks = parsed.tasks.map((t) =>
          allowedRoles.has(t.role) ? t : { ...t, role: tierConfig.availableRoles[0] as TechnicalTask['role'] },
        );
      }

      // Guard: enforce max tasks per iteration
      if (parsed.tasks.length > tierConfig.maxTasksPerIteration) {
        this.logger.warn(
          `Architect generated ${parsed.tasks.length} tasks for tier "${teamTier}" (max ${tierConfig.maxTasksPerIteration}). Trimming by priority.`,
        );
        parsed.tasks = parsed.tasks
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
          .slice(0, tierConfig.maxTasksPerIteration);
      }

      return parsed;
    } catch (err) {
      this.logger.warn(`Architect deriveTasks fallback (tier: ${teamTier}): ${(err as Error).message}`);

      // Tier-appropriate fallback: use the first allowed role as the main dev,
      // and only add testing if the tier allows it.
      const mainRole = (tierConfig.availableRoles[0] ?? 'full_stack') as TechnicalTask['role'];
      const iterN = iteration.number ?? 1;
      const fallbackTasks: TechnicalTask[] = [
        {
          title: `Implementar objetivo: ${iteration.objective.slice(0, 60)}`,
          prompt: `${iteration.objective}\n\nContexto del goal: ${goal.description ?? goal.title}\n\nCriterios de aceptación:\n${missingCriteria.map((c) => `- ${c.description}`).join('\n')}`,
          role: mainRole,
          priority: 100,
          dependsOn: [],
          acceptanceCriteria: missingCriteria.slice(0, 3).map((c) => ({ ...c, verifiable: true })),
          branchName: `agent/${mainRole}/iter-${iterN}-main`,
          riskLevel: 'medium' as const,
          requiresHumanApproval: false,
        },
      ];

      // Only add a testing task if the tier permits it and there are criteria to test
      if (tierConfig.availableRoles.includes('testing') && missingCriteria.length > 0) {
        fallbackTasks.push({
          title: `Testing: ${goal.title.slice(0, 50)}`,
          prompt: `Crea tests para los cambios de la tarea principal de la iteración ${iterN}. Valida los criterios de aceptación del goal.`,
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
          branchName: `agent/testing/iter-${iterN}-tests`,
          riskLevel: 'low' as const,
          requiresHumanApproval: false,
        });
      }

      return {
        tasks: fallbackTasks,
        architectureNotes: `Plan de fallback generado automáticamente (tier: ${teamTier}).`,
        risks: [],
        humanApprovalRequired: false,
      };
    }
  }

}
