import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MemoryAgentService } from '../memory/memory-agent.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { ScheduleService } from './schedule.service';

// ── Types ────────────────────────────────────────────────────────────────────

export type PatternType = 'commute' | 'food' | 'gym' | 'routine' | 'uber' | 'shopping' | 'other';

export interface PatternSuggestedAction {
  type: 'uber' | 'food_order' | 'reminder' | 'wear_notify' | 'open_app' | 'info';
  message: string;           // what EVA says to the user
  destination?: string;      // for uber: 'work', 'home', a place label
  restaurant?: string;       // for food_order
  app_package?: string;      // for open_app (e.g. 'com.ubercab')
  deep_link?: string;        // for open_app
}

export interface BehaviorPattern {
  id: string;
  org_id: string;
  pattern_type: PatternType;
  title: string;
  description?: string;
  trigger_days?: string[];
  trigger_time?: string;
  trigger_place_id?: string;
  suggested_action: PatternSuggestedAction;
  confidence: number;
  confirmed: boolean;
  active: boolean;
  last_triggered?: string;
  sample_count: number;
  created_at: string;
}

export interface ProactiveSuggestion {
  pattern: BehaviorPattern;
  message: string;          // what EVA should say
  urgency: 'low' | 'medium' | 'high';
}

const DAY_NAMES: Record<number, string> = {
  0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat',
};

const PATTERN_DETECTION_PROMPT = `Eres un analizador de comportamiento para un asistente personal (EVA).
Analiza las memorias recientes del usuario e identifica patrones de comportamiento consistentes.
Busca: rutinas de transporte (hora de salida, destinos frecuentes), hábitos de comida (restaurantes, horarios),
ejercicio, compras frecuentes, y otros patrones repetitivos que EVA pueda usar para sugerir acciones proactivas.

Responde JSON estricto con un array de patrones encontrados:
[{
  "pattern_type": "commute|food|gym|routine|uber|shopping|other",
  "title": "descripcion corta",
  "description": "detalle del patron",
  "trigger_days": ["mon","tue","wed","thu","fri"],
  "trigger_time": "HH:mm",
  "suggested_action": {
    "type": "uber|food_order|reminder|open_app|info",
    "message": "lo que EVA dira al usuario",
    "destination": "work|home|label (si aplica)",
    "restaurant": "nombre (si aplica)"
  },
  "confidence": 0.0-1.0
}]

Si no hay patrones claros, responde [].`;

@Injectable()
export class BehaviorPatternService {
  private readonly logger = new Logger(BehaviorPatternService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly memoryAgent: MemoryAgentService,
    private readonly modelRouter: ModelRouterService,
    private readonly schedule: ScheduleService,
  ) {}

  // ── Pattern CRUD ──────────────────────────────────────────────────────────

  async getActivePatterns(orgId: string): Promise<BehaviorPattern[]> {
    const { data } = await this.db.admin
      .from('behavior_patterns')
      .select('*')
      .eq('org_id', orgId)
      .eq('active', true)
      .order('confidence', { ascending: false });
    return (data ?? []) as BehaviorPattern[];
  }

  async confirmPattern(orgId: string, patternId: string): Promise<void> {
    await this.db.admin
      .from('behavior_patterns')
      .update({ confirmed: true, confidence: 1.0 })
      .eq('id', patternId)
      .eq('org_id', orgId);
  }

  async dismissPattern(orgId: string, patternId: string): Promise<void> {
    await this.db.admin
      .from('behavior_patterns')
      .update({ active: false })
      .eq('id', patternId)
      .eq('org_id', orgId);
  }

  // ── Proactive trigger check ───────────────────────────────────────────────

  /**
   * Returns patterns that should fire RIGHT NOW based on current time and day.
   * Called before every agent response to inject proactive suggestions.
   * A pattern fires when:
   *   • today is in trigger_days
   *   • current time is within ±30 min of trigger_time
   *   • it hasn't been triggered in the last 20 hours
   */
  async getTriggersNow(orgId: string): Promise<ProactiveSuggestion[]> {
    const patterns = await this.getActivePatterns(orgId);
    const now = new Date();
    const todayDay = DAY_NAMES[now.getDay()];
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const triggered: ProactiveSuggestion[] = [];

    for (const p of patterns) {
      if (!p.trigger_time) continue;
      if (p.trigger_days && !p.trigger_days.includes(todayDay)) continue;

      const [h, m] = p.trigger_time.split(':').map(Number);
      const patternMin = h * 60 + m;
      const diff = Math.abs(nowMin - patternMin);
      if (diff > 30) continue;

      // Don't re-trigger within 20 hours
      if (p.last_triggered) {
        const hoursSince = (now.getTime() - new Date(p.last_triggered).getTime()) / 3_600_000;
        if (hoursSince < 20) continue;
      }

      const urgency: 'low' | 'medium' | 'high' =
        p.confidence >= 0.85 ? 'high'
        : p.confidence >= 0.65 ? 'medium'
        : 'low';

      triggered.push({ pattern: p, message: p.suggested_action.message, urgency });
    }

    return triggered;
  }

  /**
   * Formats active patterns as a soul context block — tells EVA what
   * behavioral tendencies the user has so she can proactively offer help.
   */
  async formatPatternsForSoul(orgId: string): Promise<string | null> {
    const patterns = await this.getActivePatterns(orgId);
    const highConf = patterns.filter(p => p.confidence >= 0.6);
    if (highConf.length === 0) return null;

    const lines = highConf.slice(0, 6).map(p => {
      const days = p.trigger_days?.map(d => DAY_NAMES[d as unknown as number] ?? d).join('/') ?? 'variable';
      const time = p.trigger_time ? ` ~${p.trigger_time}` : '';
      const confirmed = p.confirmed ? ' ✓' : '';
      return `- ${p.title}${time} (${days})${confirmed}`;
    });

    return lines.join('\n');
  }

  // ── Pattern detection (runs periodically or on demand) ────────────────────

  /**
   * Reads recent episodic memories + schedule and uses LLM to detect new patterns.
   * Saves detected patterns to behavior_patterns table.
   * Safe to call repeatedly — uses sample_count + confidence to deduplicate.
   * Returns number of new patterns detected.
   */
  async detectPatterns(orgId: string): Promise<number> {
    // Get recent memories (last 30 days)
    const memories = await this.memoryAgent.recall(
      'rutina transporte comida gym uber salir trabajo horario patrones comportamiento',
      orgId, 20, 0.50,
    ).catch(() => []);

    // Get schedule events for context
    const scheduleBlock = await this.schedule.formatUpcomingForSoul(orgId, 30).catch(() => null);

    if (memories.length < 3 && !scheduleBlock) {
      this.logger.debug(`Not enough data to detect patterns for org ${orgId}`);
      return 0;
    }

    const memorySummaries = memories
      .map(m => `[${m.created_at.slice(0, 10)}] ${m.summary}`)
      .join('\n');

    const prompt = [
      `Memorias recientes del usuario:\n${memorySummaries}`,
      scheduleBlock ? `\nAgenda conocida:\n${scheduleBlock}` : '',
    ].join('\n');

    let detected: Array<{
      pattern_type: PatternType;
      title: string;
      description?: string;
      trigger_days?: string[];
      trigger_time?: string;
      suggested_action: { type: string; message: string; destination?: string; restaurant?: string };
      confidence: number;
    }> = [];

    try {
      const result = await this.modelRouter.generate(prompt, {
        orgId,
        budget: 'cheap',
        responseFormat: 'json',
        temperature: 0,
        maxTokens: 800,
        systemPrompt: PATTERN_DETECTION_PROMPT,
      });
      const parsed = JSON.parse(result.text);
      if (Array.isArray(parsed)) detected = parsed;
    } catch (err) {
      this.logger.warn('Pattern detection LLM call failed', err);
      return 0;
    }

    // Persist detected patterns (skip low-confidence or already existing)
    let saved = 0;
    for (const p of detected) {
      if ((p.confidence ?? 0) < 0.5) continue;
      if (!p.title || !p.pattern_type) continue;

      // Check for existing similar pattern (by title similarity)
      const { data: existing } = await this.db.admin
        .from('behavior_patterns')
        .select('id, sample_count, confidence')
        .eq('org_id', orgId)
        .eq('title', p.title)
        .maybeSingle();

      if (existing) {
        // Reinforce: bump sample_count and update confidence
        await this.db.admin
          .from('behavior_patterns')
          .update({
            sample_count: existing.sample_count + 1,
            confidence: Math.min(0.99, (existing.confidence + p.confidence) / 2 + 0.05),
            description: p.description,
          })
          .eq('id', existing.id);
      } else {
        await this.db.admin.from('behavior_patterns').insert({
          org_id: orgId,
          pattern_type: p.pattern_type,
          title: p.title,
          description: p.description ?? null,
          trigger_days: p.trigger_days ?? null,
          trigger_time: p.trigger_time ?? null,
          suggested_action: p.suggested_action,
          confidence: p.confidence,
          sample_count: 1,
          active: true,
          confirmed: false,
        });
        saved++;
      }
    }

    if (saved > 0) this.logger.log(`Detected ${saved} new patterns for org ${orgId}`);
    return saved;
  }
}
