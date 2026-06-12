import { Injectable, Logger } from '@nestjs/common';
import { SecretCipher } from '../common/secret-cipher';
import { DatabaseService } from '../database/database.service';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PersonalProfile {
  // Identity
  full_name?: string;
  preferred_address?: string;  // how EVA should address them
  age?: string;
  // Physical
  current_location?: string;
  address?: string;
  weight?: string;
  height?: string;
  allergies?: string;
  // Professional
  occupation?: string;         // what they do professionally
  workplace?: string;
  work_role?: string;          // their role in the org
  // Preferences
  likes?: string;
  dislikes?: string;
  hobbies?: string;
  values?: string;             // what matters to them
}

export type GoalStatus = 'active' | 'completed' | 'paused' | 'dropped';

export interface Goal {
  id: string;
  title: string;
  description?: string;
  status: GoalStatus;
  deadline?: string;           // ISO date YYYY-MM-DD
  progress?: string;           // free-text progress note
  created_at: string;
}

/** Rich identity context — stored in agent_souls.persona_context */
export interface PersonaContext {
  bio?: string;                // who they are in their own words
  occupation?: string;         // mirrors PersonalProfile.occupation; denormalised for fast access
  expectations?: string;       // what they expect from EVA (key for personalisation)
  routines?: string;           // daily/weekly patterns
  communication_preferences?: string;  // how they like EVA to respond
  family?: string;
  relationships?: string;
  relationship_map?: RelationshipEntry[];
  important_links?: string;
  projects?: string;           // active projects
  social_media?: string;
  work_hours?: string;
  days_off?: string;
}

export interface RelationshipEntry {
  id: string;
  display_name: string;
  relation: string;
  aliases: string[];
  contact_hint?: string;
  notes?: string;
  priority?: number;
}

export interface PrivateUserContext {
  text?: string;
  updated_at?: string;
}

/** Legacy cowork fields — kept for backward compat */
export interface CoworkContext {
  calendars?: string;
  upcoming_appointments?: string;  // static fallback; replaced by live calendar when available
  pending_tasks?: string;
  work_hours?: string;
  days_off?: string;
  goals?: string;              // legacy free-text; superseded by Goal[]
  family?: string;
  social_media?: string;
  projects?: string;
  routines?: string;
  communication_preferences?: string;
  important_links?: string;
}

export interface AgentSoulContext {
  personal_profile: PersonalProfile;
  cowork_context: CoworkContext;
  // v2 additions
  goals: Goal[];
  persona_context: PersonaContext;
  private_context?: PrivateUserContext;
  private_context_hint?: string;
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class SoulContextService {
  private readonly logger = new Logger(SoulContextService.name);

  constructor(private readonly db: DatabaseService) {}

  async getPersonalProfile(orgId: string): Promise<PersonalProfile> {
    const row = await this.fetchSoul(orgId);
    return this.personalProfileFromRow(row);
  }

  async getCoworkContext(orgId: string): Promise<CoworkContext> {
    const row = await this.fetchSoul(orgId);
    return this.coworkContextFromRow(row);
  }

  async getGoals(orgId: string): Promise<Goal[]> {
    const row = await this.fetchSoul(orgId);
    return (row?.goals ?? []) as Goal[];
  }

  async getPersonaContext(orgId: string): Promise<PersonaContext> {
    const row = await this.fetchSoul(orgId);
    return (row?.persona_context ?? {}) as PersonaContext;
  }

  async upsertGoal(orgId: string, goal: Omit<Goal, 'id' | 'created_at'>): Promise<Goal> {
    const existing = await this.getGoals(orgId);
    const newGoal: Goal = {
      id: crypto.randomUUID(),
      ...goal,
      created_at: new Date().toISOString(),
    };
    const updated = [...existing, newGoal];
    await this.db.admin
      .from('agent_souls')
      .upsert({ org_id: orgId, goals: updated }, { onConflict: 'org_id' })
      .select();
    return newGoal;
  }

  async updateGoalStatus(orgId: string, goalId: string, status: GoalStatus, progress?: string): Promise<void> {
    const goals = await this.getGoals(orgId);
    const updated = goals.map(g =>
      g.id === goalId ? { ...g, status, ...(progress ? { progress } : {}) } : g,
    );
    await this.db.admin
      .from('agent_souls')
      .upsert({ org_id: orgId, goals: updated }, { onConflict: 'org_id' })
      .select();
  }

  async updatePersonaContext(orgId: string, patch: Partial<PersonaContext>): Promise<PersonaContext> {
    const current = await this.getPersonaContext(orgId);
    const merged = this.normalizePersonaContext({ ...current, ...patch });
    await this.db.admin
      .from('agent_souls')
      .upsert({ org_id: orgId, persona_context: merged }, { onConflict: 'org_id' })
      .select();
    return merged;
  }

  async updatePersonalProfile(orgId: string, patch: Partial<PersonalProfile>): Promise<PersonalProfile> {
    const row = await this.fetchSoul(orgId);
    const current = this.personalProfileFromRow(row);
    const merged = { ...current, ...patch };
    const currentPersona = this.normalizePersonaContext((row?.persona_context ?? {}) as PersonaContext);
    await this.db.admin
      .from('agent_souls')
      .upsert(
        { org_id: orgId, persona_context: { ...currentPersona, personal_profile: merged } },
        { onConflict: 'org_id' },
      )
      .select();
    return merged;
  }

  async savePrivateUserContext(orgId: string, text: string): Promise<{ private_context_hint: string }> {
    const trimmed = text.trim();
    const encrypted = trimmed ? SecretCipher.encrypt(JSON.stringify({
      text: trimmed,
      updated_at: new Date().toISOString(),
    } satisfies PrivateUserContext)) : null;
    const hint = trimmed ? this.privateContextHint(trimmed) : null;

    await this.db.admin
      .from('agent_souls')
      .upsert(
        { org_id: orgId, private_context_ciphertext: encrypted, private_context_hint: hint },
        { onConflict: 'org_id' },
      )
      .select('org_id');

    return { private_context_hint: hint ?? '' };
  }

  /** Full context assembled in one DB round-trip. */
  async getAgentContext(orgId: string): Promise<AgentSoulContext> {
    const row = await this.fetchSoul(orgId);
    const persona = this.normalizePersonaContext((row?.persona_context ?? {}) as PersonaContext);
    return {
      personal_profile: this.personalProfileFromRow(row),
      cowork_context: this.coworkContextFromRow(row),
      goals: (row?.goals ?? []) as Goal[],
      persona_context: persona,
      private_context: this.decryptPrivateContext(row),
      private_context_hint: typeof row?.private_context_hint === 'string' ? row.private_context_hint : undefined,
    };
  }

  async resolveCurrentLocation(orgId: string): Promise<string | null> {
    const profile = await this.getPersonalProfile(orgId);
    return profile.current_location?.trim() || profile.address?.trim() || null;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async fetchSoul(orgId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.db.admin
      .from('agent_souls')
      .select('model_prefs, goals, persona_context, private_context_ciphertext, private_context_hint')
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      this.logger.warn(`Could not read soul for org ${orgId}: ${error.message}`);
      return null;
    }
    return data as Record<string, unknown> | null;
  }

  private personalProfileFromRow(row: Record<string, unknown> | null): PersonalProfile {
    const prefs = (row?.model_prefs ?? {}) as { personal_profile?: PersonalProfile };
    const persona = (row?.persona_context ?? {}) as PersonaContext & { personal_profile?: PersonalProfile };
    return persona.personal_profile ?? prefs.personal_profile ?? {};
  }

  private coworkContextFromRow(row: Record<string, unknown> | null): CoworkContext {
    const prefs = (row?.model_prefs ?? {}) as { cowork_context?: CoworkContext };
    const persona = (row?.persona_context ?? {}) as PersonaContext & { cowork_context?: CoworkContext };
    return persona.cowork_context ?? prefs.cowork_context ?? {};
  }

  private normalizePersonaContext(context: PersonaContext): PersonaContext {
    return {
      ...context,
      relationship_map: this.normalizeRelationships(context.relationship_map ?? []),
    };
  }

  private normalizeRelationships(entries: RelationshipEntry[]): RelationshipEntry[] {
    return entries
      .filter((entry) => entry.display_name?.trim() || entry.relation?.trim())
      .map((entry, index) => {
        const relation = this.normalizeAlias(entry.relation);
        const aliases = new Set<string>([
          relation,
          ...this.defaultRelationAliases(relation),
          ...((entry.aliases ?? []).map((alias) => this.normalizeAlias(alias))),
        ].filter(Boolean));

        return {
          id: entry.id || crypto.randomUUID(),
          display_name: entry.display_name?.trim() ?? '',
          relation,
          aliases: [...aliases],
          contact_hint: entry.contact_hint?.trim() || undefined,
          notes: entry.notes?.trim() || undefined,
          priority: entry.priority ?? index,
        };
      });
  }

  private defaultRelationAliases(relation: string): string[] {
    const aliases: Record<string, string[]> = {
      mama: ['mamá', 'madre', 'mami', 'mi mama', 'mi mamá', 'mi madre'],
      papa: ['papá', 'padre', 'papi', 'mi papa', 'mi papá', 'mi padre'],
      hermano: ['brother', 'mi hermano'],
      hermana: ['mi hermana'],
      pareja: ['novia', 'novio', 'esposa', 'esposo', 'mi pareja'],
      jefe: ['jefa', 'mi jefe', 'mi jefa'],
    };
    return aliases[relation] ?? [`mi ${relation}`];
  }

  private normalizeAlias(value?: string): string {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  private decryptPrivateContext(row: Record<string, unknown> | null): PrivateUserContext | undefined {
    const ciphertext = typeof row?.private_context_ciphertext === 'string' ? row.private_context_ciphertext : '';
    if (!ciphertext) return undefined;
    try {
      return JSON.parse(SecretCipher.decrypt(ciphertext)) as PrivateUserContext;
    } catch (error) {
      this.logger.warn(`Could not decrypt private soul context: ${(error as Error).message}`);
      return undefined;
    }
  }

  private privateContextHint(text: string): string {
    const words = text.split(/\s+/).filter(Boolean).length;
    return `${words} words stored encrypted`;
  }
}
