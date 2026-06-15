import { Injectable, Logger } from '@nestjs/common';
import { ModelRouterService } from '../model-router/model-router.service';
import { DevSessionService } from './dev-session.service';
import { DevSession, DevGoal, DevIteration, AGENT_SYSTEM_PROMPTS, SuccessCriterion } from './dev-studio.types';

/** Extract the first valid JSON object/array from a possibly noisy LLM response. */
function extractJson<T>(text: string): T {
  // Strip markdown code fences
  let s = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');

  // Try direct parse first
  try { return JSON.parse(s) as T; } catch { /* continue */ }

  // Find first { or [ and take from there
  const start = Math.min(
    s.indexOf('{') === -1 ? Infinity : s.indexOf('{'),
    s.indexOf('[') === -1 ? Infinity : s.indexOf('['),
  );
  if (start !== Infinity) s = s.slice(start);

  // Find matching close bracket by scanning
  const open = s[0];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let end = -1;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) { end = i; break; } }
    }
  }
  const candidate = end !== -1 ? s.slice(0, end + 1) : s;
  return JSON.parse(candidate) as T;
}

interface NorthStarResult {
  northStar: string;
  definitionOfDone: SuccessCriterion[];
  goals: Array<{
    title: string;
    description: string;
    priority: number;
    successCriteria: SuccessCriterion[];
  }>;
}

interface GoalEvaluation {
  score: number;
  completedCriteria: string[];
  missingCriteria: string[];
  summary: string;
  needsMoreWork: boolean;
  suggestedNextObjective: string;
}

interface IterationPlan {
  title: string;
  objective: string;
  plannedOutputs: string[];
}

const NORTH_STAR_SYSTEM = `${AGENT_SYSTEM_PROMPTS.project_manager}

Tu tarea ahora es: dado el prompt de un usuario que quiere construir un producto de software, genera:
1. Una North Star clara (1-2 oraciones que definan el estado de éxito del producto)
2. Una lista de Definition of Done (criterios verificables para considerar el proyecto completo)
3. Los goals de producto iniciales, ordenados por prioridad

Responde SOLO en JSON:
{
  "northStar": "Una app usable en staging para gestionar X",
  "definitionOfDone": [
    {"id": "dod-1", "description": "El usuario puede hacer X", "verifiable": true},
    {"id": "dod-2", "description": "La app está desplegada en staging", "verifiable": true}
  ],
  "goals": [
    {
      "title": "Nombre corto del goal",
      "description": "Qué se busca lograr con este goal",
      "priority": 100,
      "successCriteria": [
        {"id": "sc-1", "description": "Criterio verificable y específico", "verifiable": true}
      ]
    }
  ]
}
Genera 3-6 goals. Priority: 100 = crítico, 50 = importante, 10 = nice-to-have.`;

const EVAL_SYSTEM = `${AGENT_SYSTEM_PROMPTS.project_manager}

Tu tarea ahora es: evaluar si un goal de producto está completo basándote en los outputs de una iteración.
Sé riguroso: un goal no está completo si faltan criterios verificables, no hay tests, o el usuario no lo ha probado.

Responde SOLO en JSON:
{
  "score": 0.65,
  "completedCriteria": ["id-criterio-1", "id-criterio-2"],
  "missingCriteria": ["id-criterio-3"],
  "summary": "Se completó X pero falta Y. Los tests no cubren Z.",
  "needsMoreWork": true,
  "suggestedNextObjective": "Completar la validación de Z y agregar tests para el flujo principal"
}`;

const ITERATION_SYSTEM = `${AGENT_SYSTEM_PROMPTS.project_manager}

Tu tarea ahora es: dado un goal incompleto y su historial de iteraciones, planear la siguiente iteración.
La iteración debe atacar los criterios faltantes más críticos, sin duplicar trabajo ya hecho.

Responde SOLO en JSON:
{
  "title": "Iteración N — Nombre descriptivo",
  "objective": "Objetivo específico y verificable para esta iteración",
  "plannedOutputs": [
    "Output concreto 1 (ej: endpoint PUT /products/:id con validación)",
    "Output concreto 2 (ej: tests de integración para el flujo de login)"
  ]
}`;

@Injectable()
export class DevProjectManagerService {
  private readonly logger = new Logger(DevProjectManagerService.name);

  constructor(
    private readonly modelRouter: ModelRouterService,
    private readonly sessionService: DevSessionService,
  ) {}

  async generateNorthStarAndGoals(session: DevSession): Promise<NorthStarResult> {
    const prompt = `El usuario quiere construir el siguiente producto:\n\n"${session.original_prompt}"\n\nGenera la North Star, Definition of Done y goals iniciales.`;

    const result = await this.modelRouter.generate(prompt, {
      orgId: session.org_id,
      budget: 'balanced',
      systemPrompt: NORTH_STAR_SYSTEM,
      responseFormat: 'json',
      temperature: 0.3,
    });

    const parsed = extractJson<NorthStarResult>(result.text);

    if (!parsed.northStar || !Array.isArray(parsed.goals)) {
      throw new Error('PM Agent: respuesta de North Star inválida');
    }

    // Ensure all success criteria have IDs
    parsed.goals = parsed.goals.map((g, gi) => ({
      ...g,
      successCriteria: (g.successCriteria ?? []).map((c, ci) => ({
        id: (c as SuccessCriterion).id ?? `sc-${gi}-${ci}`,
        description: (c as SuccessCriterion).description ?? String(c),
        verifiable: (c as SuccessCriterion).verifiable ?? true,
      })),
    }));

    return parsed;
  }

  async evaluateGoalCompletion(
    session: DevSession,
    goal: DevGoal,
    iteration: DevIteration,
  ): Promise<GoalEvaluation> {
    const completedOutputs = iteration.completed_outputs ?? [];
    const successCriteria = goal.success_criteria ?? [];

    const prompt = `
Goal: "${goal.title}"
Descripción: ${goal.description ?? 'N/A'}

Criterios de éxito:
${successCriteria.map((c) => `- [${(c as SuccessCriterion).id}] ${(c as SuccessCriterion).description}`).join('\n')}

Outputs completados en esta iteración (${iteration.title}):
${completedOutputs.length > 0 ? completedOutputs.join('\n') : 'Ninguno reportado'}

Objetivo de la iteración: ${iteration.objective}
Evaluación existente: ${JSON.stringify(iteration.evaluation ?? {})}

Evalúa si el goal está completo.`.trim();

    let parsed: GoalEvaluation;
    try {
      const result = await this.modelRouter.generate(prompt, {
        orgId: session.org_id,
        budget: 'cheap',
        systemPrompt: EVAL_SYSTEM,
        responseFormat: 'json',
        temperature: 0,
      });
      parsed = extractJson<GoalEvaluation>(result.text);
    } catch {
      // Fallback: if no outputs, needs more work
      parsed = {
        score: 0.3,
        completedCriteria: [],
        missingCriteria: successCriteria.map((c) => (c as SuccessCriterion).id),
        summary: 'No se pudo evaluar automáticamente. La iteración no reportó outputs.',
        needsMoreWork: true,
        suggestedNextObjective: `Completar los criterios faltantes de "${goal.title}"`,
      };
    }

    return parsed;
  }

  async planNextIteration(
    session: DevSession,
    goal: DevGoal,
    evaluation: GoalEvaluation,
    iterationNumber: number,
  ): Promise<IterationPlan> {
    const prompt = `
Goal: "${goal.title}"
Descripción: ${goal.description ?? 'N/A'}

Evaluación de la iteración anterior (iteración ${iterationNumber - 1}):
- Score: ${evaluation.score}
- Criterios completados: ${evaluation.completedCriteria.join(', ') || 'ninguno'}
- Criterios faltantes: ${evaluation.missingCriteria.join(', ') || 'ninguno'}
- Resumen: ${evaluation.summary}
- Próximo objetivo sugerido: ${evaluation.suggestedNextObjective}

Esto es la iteración #${iterationNumber}. Planea la siguiente ronda de trabajo para completar el goal.`.trim();

    try {
      const result = await this.modelRouter.generate(prompt, {
        orgId: session.org_id,
        budget: 'cheap',
        systemPrompt: ITERATION_SYSTEM,
        responseFormat: 'json',
        temperature: 0.2,
      });
      const parsed = extractJson<IterationPlan>(result.text);
      if (!parsed.title || !parsed.objective) throw new Error('invalid plan');
      return parsed;
    } catch {
      return {
        title: `Iteración #${iterationNumber} — Continuar goal: ${goal.title}`,
        objective: evaluation.suggestedNextObjective || `Completar los criterios faltantes de "${goal.title}"`,
        plannedOutputs: evaluation.missingCriteria.map((id) => {
          const c = (goal.success_criteria as SuccessCriterion[]).find((s) => s.id === id);
          return c ? `Cumplir: ${c.description}` : `Completar criterio ${id}`;
        }),
      };
    }
  }

  async generateSessionCloseMessage(session: DevSession, goals: DevGoal[]): Promise<string> {
    const completedGoals = goals.filter((g) => g.status === 'completed' || g.status === 'validated');
    const msg = [
      `🎉 **Todos los goals de "${session.title}" están completos.**\n`,
      `North Star: _${session.north_star ?? 'N/A'}_\n`,
      `**Goals completados (${completedGoals.length}/${goals.length}):**`,
      ...completedGoals.map((g) => `  ✓ ${g.title}`),
      `\n¿Qué quieres hacer ahora?\n`,
      `- **Preparar release**: empaquetamos y desplegamos a producción`,
      `- **Agregar nuevos goals**: continuamos el proyecto con más features`,
      `- **Pausar**: guardamos el estado y retomamos cuando quieras`,
      `- **Cerrar sesión**: el proyecto queda archivado`,
    ].join('\n');
    return msg;
  }

  async detectBlocker(errorContext: string): Promise<{ type: string; title: string; description: string; sensitive: boolean }> {
    const blockerPatterns: Array<[RegExp, { type: string; title: string; sensitive: boolean }]> = [
      [/credential|secret|api.?key|token|password|contraseña/i, { type: 'missing_credentials', title: 'Se necesitan credenciales', sensitive: true }],
      [/account|cuenta|supabase|vercel|stripe|github|cloudflare/i, { type: 'missing_account', title: 'Se necesita crear una cuenta externa', sensitive: false }],
      [/permission|permiso|acceso/i, { type: 'missing_permission', title: 'Faltan permisos', sensitive: false }],
      [/architecture|arquitectura|diseño|modelo de datos|schema/i, { type: 'needs_architecture_decision', title: 'Se necesita decisión de arquitectura', sensitive: false }],
      [/product|alcance|scope|feature|funcionalidad/i, { type: 'needs_product_decision', title: 'Se necesita decisión de producto', sensitive: false }],
      [/quota|cuota|rate limit|limit/i, { type: 'quota_exhausted', title: 'Se agotó una cuota o límite', sensitive: false }],
    ];

    for (const [pattern, meta] of blockerPatterns) {
      if (pattern.test(errorContext)) {
        return {
          ...meta,
          description: `El agente encontró un bloqueo: ${errorContext.slice(0, 300)}`,
        };
      }
    }

    return {
      type: 'environment_not_ready',
      title: 'Bloqueo de entorno',
      description: `El agente encontró un bloqueo que requiere intervención humana: ${errorContext.slice(0, 300)}`,
      sensitive: false,
    };
  }
}
