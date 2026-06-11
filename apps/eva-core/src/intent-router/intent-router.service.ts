import { Injectable, Logger } from '@nestjs/common';
import { ModelRouterService } from '../model-router/model-router.service';
import { IntentRouterRepository } from './intent-router.repository';
import {
  Intent,
  IntentClassification,
  APPROVAL_SIGNALS,
  FAST_PATH_SIGNALS,
} from './intent-router.types';

const RULE_CONFIDENCE_THRESHOLD = 0.75; // below this → try LLM
const LLM_SYSTEM_PROMPT = `You are an intent classifier for an AI agent platform.
Classify the user input into exactly one of:
  fast_path         - simple question, lookup, or status check; no side effects
  core_path         - complex task requiring multi-step agent work
  core_path_approval - destructive or sensitive action requiring human approval

Respond with JSON only: {"intent": "<one of the three values>", "reason": "<one sentence>"}`;

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger(IntentRouterService.name);

  constructor(
    private readonly repo: IntentRouterRepository,
    private readonly modelRouter: ModelRouterService,
  ) {}

  async classify(
    input: string,
    orgId: string,
    opts: { taskId?: string; context?: string } = {},
  ): Promise<IntentClassification> {
    // 1. Rule-based pass (fast, deterministic)
    const ruleResult = this.classifyByRules(input);

    let result = ruleResult;

    // 2. LLM fallback when rules are uncertain
    if (ruleResult.confidence < RULE_CONFIDENCE_THRESHOLD) {
      result = await this.classifyByLLM(input, orgId, opts.taskId, opts.context);
      result = {
        ...result,
        classifier: ruleResult.confidence > 0 ? 'hybrid' : 'llm',
        reasons:    [...ruleResult.reasons, ...result.reasons],
      };
    }

    // 3. Record every classification (fire-and-forget — don't block response)
    this.repo
      .record({
        org_id:     orgId,
        task_id:    opts.taskId,
        input,
        intent:     result.intent,
        confidence: result.confidence,
        classifier: result.classifier,
        metadata:   { reasons: result.reasons, context: opts.context },
      })
      .catch(err => this.logger.error('Failed to record intent route', err));

    return result;
  }

  // ── Rule-based classifier ─────────────────────────────────────────────────

  classifyByRules(input: string): IntentClassification {
    const normalized = input.toLowerCase().trim();
    const reasons: string[] = [];

    // Check approval signals first (highest priority) — phrase-level match
    const approvalHit = APPROVAL_SIGNALS.find(s => this.matchPhrase(normalized, s));
    if (approvalHit) {
      reasons.push(`approval signal: "${approvalHit}"`);
      return { intent: 'core_path_approval', confidence: 0.95, classifier: 'rules', reasons };
    }

    const hasQ = normalized.includes('?');

    // Fast signals: phrase-level match (word-boundary aware for multi-word phrases)
    const fastHits = FAST_PATH_SIGNALS.filter(s => this.matchPhrase(normalized, s));

    // Core signals: word-boundary match to avoid "deployment" matching "deploy",
    // "running" matching "run", etc.
    const coreHits = this.corePathSignals().filter(s => this.matchWord(normalized, s));

    fastHits.forEach(s => reasons.push(`fast signal: "${s}"`));
    coreHits.forEach(s => reasons.push(`core signal: "${s}"`));
    if (hasQ) reasons.push('question mark present');

    const isShort = normalized.length < 80;

    // Question + fast signal → informational request even if a core keyword appears.
    // e.g. "How do I configure Redis?" = asking how, not requesting action.
    if (hasQ && fastHits.length > 0) {
      const confidence = fastHits.length >= 2 ? 0.90 : 0.80;
      reasons.push('question with fast signal — informational');
      return { intent: 'fast_path', confidence, classifier: 'rules', reasons };
    }

    if (fastHits.length > 0 && coreHits.length === 0) {
      const confidence = fastHits.length >= 2 ? 0.90 : 0.80;
      return { intent: 'fast_path', confidence, classifier: 'rules', reasons };
    }

    if (isShort && coreHits.length === 0) {
      reasons.push('short query with no core signals');
      return { intent: 'fast_path', confidence: 0.70, classifier: 'rules', reasons };
    }

    if (coreHits.length > 0) {
      const confidence = coreHits.length >= 2 ? 0.85 : 0.76;
      return { intent: 'core_path', confidence, classifier: 'rules', reasons };
    }

    // Uncertain — return low-confidence fast_path, let LLM decide
    reasons.push('no strong signals — uncertain');
    return { intent: 'fast_path', confidence: 0.50, classifier: 'rules', reasons };
  }

  // Match a multi-word phrase (handles spaces between words)
  private matchPhrase(text: string, phrase: string): boolean {
    // Escape regex special chars, replace spaces with \s+ for multi-word phrases
    const pattern = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(pattern).test(text);
  }

  // Word-boundary match: "run" must not match "running", "deploy" not "deployment"
  private matchWord(text: string, word: string): boolean {
    const pattern = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`\\b${pattern}\\b`).test(text);
  }

  // ── LLM classifier ────────────────────────────────────────────────────────

  private async classifyByLLM(input: string, orgId: string, taskId?: string, context?: string): Promise<IntentClassification> {
    const prompt = context ? `Context: ${context}\n\nInput: ${input}` : input;

    try {
      const result = await this.modelRouter.generate(prompt, {
        orgId,
        taskId,
        requestType: 'reasoning',
        systemPrompt:   LLM_SYSTEM_PROMPT,
        responseFormat: 'json',
        budget:         'cheap',
        temperature:    0,
        maxTokens:      100,
      });

      const parsed = JSON.parse(result.text) as { intent?: string; reason?: string };
      const intent = this.parseIntent(parsed.intent);

      return {
        intent,
        confidence: 0.82,
        classifier: 'llm',
        reasons:    [parsed.reason ?? 'llm classification'],
      };
    } catch (err) {
      this.logger.warn('LLM classification failed, defaulting to core_path', err);
      return { intent: 'core_path', confidence: 0.55, classifier: 'llm', reasons: ['llm error — safe default'] };
    }
  }

  private parseIntent(raw?: string): Intent {
    if (raw === 'fast_path' || raw === 'core_path' || raw === 'core_path_approval') return raw;
    return 'core_path';
  }

  private corePathSignals(): string[] {
    return [
      'create', 'build', 'implement', 'generate', 'analyze', 'analyse',
      'optimize', 'optimise', 'run', 'execute', 'process', 'migrate',
      'refactor', 'update', 'deploy', 'install', 'configure', 'setup',
      'schedule', 'automate', 'monitor', 'alert', 'integrate',
    ];
  }
}
