import { Injectable, Logger } from '@nestjs/common';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { SoulContextService } from './soul-context.service';

/** Minimum input length worth digesting — skip one-liners and greetings */
const MIN_INPUT_LENGTH = 40;

/** Greetings / trivial turns never get their own memory entry */
const TRIVIAL_PATTERN = /^(hola|hey|gracias|ok|vale|bye|adi[oó]s|sí|no|perfecto|entendido|claro|buenas|👍|✓)\b/i;

/** If the agent's answer is one of these, nothing meaningful happened */
const TRIVIAL_ANSWER_PATTERN = /^(entendido|claro|ok|de acuerdo|perfectamente|con gusto)\b/i;

/** System prompt used to generate the conversation summary */
const DIGEST_SYSTEM_PROMPT = `Eres un sistema de memoria para un asistente personal (EVA).
Tu tarea: resumir en 1-3 oraciones cortas qué ocurrió en esta interacción.
Incluye: qué pidió el usuario, qué hizo o respondió EVA, y cualquier dato personal o decisión relevante.
NO inventes información. Si fue una conversación trivial, responde con la palabra SKIP.
Responde solo con el resumen, sin encabezados ni listas.`;

export interface DigestInput {
  orgId: string;
  taskId: string;
  userInput: string;       // what the user said
  evaReply: string;        // what EVA answered
  /** Optional last 3 turns for context */
  conversationContext?: Array<{ role: 'user' | 'assistant'; text: string }>;
}

@Injectable()
export class ConversationDigesterService {
  private readonly logger = new Logger(ConversationDigesterService.name);

  constructor(
    private readonly memoryAgent: MemoryAgentService,
    private readonly modelRouter: ModelRouterService,
    private readonly soul: SoulContextService,
  ) {}

  /**
   * Fire-and-forget: call this after every deliver().
   * Summarises the turn and stores an episodic memory.
   * Never throws — any failure is logged and swallowed.
   */
  async digestAsync(input: DigestInput): Promise<void> {
    this.digest(input).catch(err =>
      this.logger.warn(`Digest failed for task ${input.taskId}`, err),
    );
  }

  private async digest(input: DigestInput): Promise<void> {
    if (!this.isWorthDigesting(input)) return;

    const summary = await this.generateSummary(input);
    if (!summary || summary.trim().toUpperCase() === 'SKIP') return;

    const today = new Date().toISOString().slice(0, 10);

    await this.memoryAgent.ingest(
      {
        content: this.buildFullContent(input),
        summary,
        memory_type: 'episodic',
        agent_id: 'eva',
        task_id: input.taskId,
        metadata: {
          session_date: today,
          auto_generated: true,
          user_input_preview: input.userInput.slice(0, 100),
        },
      },
      input.orgId,
    );

    this.logger.log(`Episodic memory saved for org ${input.orgId} task ${input.taskId}`);

    // Opportunistically update soul profile if the turn revealed personal info
    await this.maybeUpdateSoulProfile(input);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private isWorthDigesting(input: DigestInput): boolean {
    if (input.userInput.length < MIN_INPUT_LENGTH) return false;
    if (TRIVIAL_PATTERN.test(input.userInput.trim())) return false;
    if (TRIVIAL_ANSWER_PATTERN.test(input.evaReply.trim())) return false;
    return true;
  }

  private buildFullContent(input: DigestInput): string {
    const context = (input.conversationContext ?? [])
      .slice(-3)
      .map(t => `${t.role === 'user' ? 'Usuario' : 'EVA'}: ${t.text}`)
      .join('\n');

    return [
      context ? `Contexto previo:\n${context}\n` : '',
      `Usuario: ${input.userInput}`,
      `EVA: ${input.evaReply}`,
    ].filter(Boolean).join('\n');
  }

  private async generateSummary(input: DigestInput): Promise<string | null> {
    const prompt = [
      `Fecha: ${new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
      `Usuario dijo: "${input.userInput.slice(0, 400)}"`,
      `EVA respondió: "${input.evaReply.slice(0, 400)}"`,
    ].join('\n');

    try {
      const result = await this.modelRouter.generate(prompt, {
        orgId: input.orgId,
        taskId: input.taskId,
        requestType: 'reasoning',
        budget: 'cheap',
        maxTokens: 120,
        temperature: 0,
        systemPrompt: DIGEST_SYSTEM_PROMPT,
      });
      return result.text.trim();
    } catch (err) {
      this.logger.warn('Digest summary generation failed', err);
      return null;
    }
  }

  /**
   * Detect if the conversation revealed personal information and update soul.
   * Only runs for a narrow set of high-signal patterns.
   */
  private async maybeUpdateSoulProfile(input: DigestInput): Promise<void> {
    const text = input.userInput.toLowerCase();

    // Occupation updates
    const occupationMatch = text.match(
      /\b(soy|trabajo como|me dedico a|mi trabajo es|mi profesión es)\s+([^,.!?]{4,60})/i,
    );
    if (occupationMatch?.[2]) {
      const occupation = occupationMatch[2].trim();
      await this.soul.updatePersonalProfile(input.orgId, { occupation }).catch(() => null);
      this.logger.log(`Soul profile updated — occupation: "${occupation}"`);
    }

    // Location updates
    const locationMatch = text.match(
      /\b(estoy en|vivo en|me encuentro en|mi ciudad es|actualmente en)\s+([^,.!?]{3,40})/i,
    );
    if (locationMatch?.[2]) {
      const location = locationMatch[2].trim();
      await this.soul.updatePersonalProfile(input.orgId, { current_location: location }).catch(() => null);
    }
  }
}
