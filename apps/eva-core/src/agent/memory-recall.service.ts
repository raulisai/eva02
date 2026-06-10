import { Injectable, Logger } from '@nestjs/common';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { MemorySearchResult } from '../memory/memory.types';

/**
 * Signals that the user is asking EVA to recall a past interaction.
 * These phrases indicate "use your memory about us" — not just a web search.
 */
const RECALL_SIGNALS =
  /\b(recuerda|acuérdate|te acuerdas|recordar|recuerdas|dijiste|te dije|me dijiste|hablamos|platicamos|conversamos|te coment[eé]|te mencion[eé]|nuestra conversaci[oó]n|lo que acordamos|la [uú]ltima vez|la semana pasada|ayer que hablamos|hace unos d[ií]as|nuestras platicas|lo que hicimos|lo que estaba haciendo|lo que andaba haciendo)\b/i;

/**
 * When the recall produces memories, inject them into the prompt using
 * this wrapper so the model knows they are trusted recollections, not
 * live data.
 */
const RECALL_PROMPT_HEADER = `## Memorias relevantes de conversaciones pasadas con este usuario:
(Usa estas memorias para responder con continuidad. Si ninguna aplica, ignóralas.)

`;

export interface RecallResult {
  /** Whether the input is asking for memory recall */
  isRecall: boolean;
  /** Formatted block ready to inject into the agent prompt */
  context: string | null;
  /** Raw memory rows for logging */
  memories: MemorySearchResult[];
}

@Injectable()
export class MemoryRecallService {
  private readonly logger = new Logger(MemoryRecallService.name);

  constructor(private readonly memoryAgent: MemoryAgentService) {}

  /**
   * Checks if the input contains a recall signal. If yes, runs a vector
   * similarity search and returns formatted context for injection.
   * Safe to call on every turn — cheap Noop when no recall signal present.
   */
  async check(input: string, orgId: string): Promise<RecallResult> {
    if (!RECALL_SIGNALS.test(input)) {
      return { isRecall: false, context: null, memories: [] };
    }

    this.logger.log(`Memory recall triggered for org ${orgId}`);

    try {
      const memories = await this.memoryAgent.recall(input, orgId, 6, 0.65);

      if (memories.length === 0) {
        return {
          isRecall: true,
          context: 'No encontré memorias pasadas relevantes para este tema.',
          memories: [],
        };
      }

      const formatted = memories
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .map((m) => {
          const date = new Date(m.created_at).toLocaleDateString('es-MX', {
            day: 'numeric', month: 'short', year: 'numeric',
          });
          return `[${date}] ${m.summary}`;
        })
        .join('\n');

      return {
        isRecall: true,
        context: RECALL_PROMPT_HEADER + formatted,
        memories,
      };
    } catch (err) {
      this.logger.warn('Memory recall search failed', err);
      return { isRecall: true, context: null, memories: [] };
    }
  }

  isRecallRequest(input: string): boolean {
    return RECALL_SIGNALS.test(input);
  }
}
