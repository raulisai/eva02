import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ZodError } from 'zod';
import { ModelRouterService } from '../model-router/model-router.service';
import { IntentRouterService } from '../intent-router/intent-router.service';
import { Plan, PlanRequest, PlanSchema, KNOWN_TOOLS } from './planner.types';

const PLANNER_SYSTEM_PROMPT = `You are a task planner for an AI agent platform.
Given a goal, produce a structured execution plan as JSON.

Rules:
- Return ONLY valid JSON — no markdown, no prose.
- "steps" must be an ordered array; each step needs: step (int), description, tool, inputs (object), requires_approval (bool).
- Available tools: ${KNOWN_TOOLS.join(', ')}.
- Approval required for: delete, bulk update, deploy to production, financial transfers.
- fast_path goals → 1-2 steps max.
- core_path goals → up to 8 steps.
- core_path_approval goals → include an approval-gate step.

JSON schema:
{
  "goal": "<string>",
  "intent": "fast_path|core_path|core_path_approval",
  "steps": [{ "step": 1, "description": "...", "tool": "...", "inputs": {}, "requires_approval": false }],
  "estimated_total_tokens": 500
}`;

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  constructor(
    private readonly modelRouter: ModelRouterService,
    private readonly intentRouter: IntentRouterService,
  ) {}

  async plan(request: PlanRequest): Promise<Plan> {
    // Auto-classify intent if not provided
    const intent = request.intent ?? (
      await this.intentRouter.classify(request.goal, request.orgId)
    ).intent;

    // Try LLM first; fall back to deterministic stub if no key
    try {
      return await this.planWithLLM(request.goal, intent, request.context);
    } catch (err) {
      this.logger.warn('LLM planner failed, using deterministic fallback', err);
      return this.planDeterministic(request.goal, intent);
    }
  }

  // ── LLM planner ───────────────────────────────────────────────────────────

  private async planWithLLM(goal: string, intent: string, context?: string): Promise<Plan> {
    const userPrompt = context
      ? `Context:\n${context}\n\nGoal: ${goal}`
      : `Goal: ${goal}`;

    const result = await this.modelRouter.generate(userPrompt, {
      systemPrompt:   PLANNER_SYSTEM_PROMPT,
      responseFormat: 'json',
      budget:         'balanced',
      temperature:    0.2,
      maxTokens:      1024,
    });

    return this.parseAndValidate(result.text, intent);
  }

  // ── Deterministic fallback (dev / no API key) ────────────────────────────

  planDeterministic(goal: string, intent: string): Plan {
    const words       = goal.toLowerCase();
    const needsSearch = /search|find|look up|web|news/.test(words);
    const needsCode   = /code|script|function|implement|build/.test(words);
    const needsApproval = intent === 'core_path_approval';

    const steps: Plan['steps'] = [];

    if (intent === 'fast_path') {
      steps.push({
        step:              1,
        description:       `Answer: ${goal}`,
        tool:              'llm-generate',
        inputs:            { prompt: goal },
        requires_approval: false,
      });
    } else {
      if (needsSearch) {
        steps.push({
          step:              1,
          description:       'Search for relevant information',
          tool:              'web-search',
          inputs:            { query: goal },
          requires_approval: false,
        });
      }

      steps.push({
        step:              steps.length + 1,
        description:       `Recall related memories for context`,
        tool:              'memory-recall',
        inputs:            { query: goal, limit: 3 },
        requires_approval: false,
      });

      if (needsCode) {
        steps.push({
          step:              steps.length + 1,
          description:       'Generate and execute code',
          tool:              'code-executor',
          inputs:            { goal },
          requires_approval: false,
        });
      } else {
        steps.push({
          step:              steps.length + 1,
          description:       'Generate response or artifact',
          tool:              'llm-generate',
          inputs:            { goal, use_context: true },
          requires_approval: false,
        });
      }

      if (needsApproval) {
        steps.push({
          step:              steps.length + 1,
          description:       'Request human approval before executing sensitive action',
          tool:              'approval-gate',
          inputs:            { action: goal, level: 'human' },
          requires_approval: true,
        });
      }
    }

    const plan = {
      goal,
      intent:                 intent as Plan['intent'],
      steps,
      estimated_total_tokens: steps.length * 200,
    };

    // Validate our own output — catches bugs in the stub logic
    return PlanSchema.parse(plan);
  }

  // ── Validation ────────────────────────────────────────────────────────────

  parseAndValidate(raw: string, intent: string): Plan {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException(`Planner returned invalid JSON: ${raw.slice(0, 200)}`);
    }

    // Inject intent from classifier if LLM omitted it or returned wrong value
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (!obj['intent']) obj['intent'] = intent;
    }

    const result = PlanSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.error('Plan validation failed', result.error.format());
      throw new BadRequestException(
        `Plan schema invalid: ${JSON.stringify((result.error as ZodError).issues.slice(0, 3))}`,
      );
    }
    return result.data;
  }
}
