import { Injectable, Logger } from '@nestjs/common';
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
  important_links?: string;
  projects?: string;           // active projects
  social_media?: string;
  work_hours?: string;
  days_off?: string;
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
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class SoulContextService {
  private readonly logger = new Logger(SoulContextService.name);

  constructor(private readonly db: DatabaseService) {}

  async getPersonalProfile(orgId: string): Promise<PersonalProfile> {
    const row = await this.fetchSoul(orgId);
    const prefs = (row?.model_prefs ?? {}) as { personal_profile?: PersonalProfile };
    return prefs.personal_profile ?? {};
  }

  async getCoworkContext(orgId: string): Promise<CoworkContext> {
    const row = await this.fetchSoul(orgId);
    const prefs = (row?.model_prefs ?? {}) as { cowork_context?: CoworkContext };
    return prefs.cowork_context ?? {};
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
    const merged = { ...current, ...patch };
    await this.db.admin
      .from('agent_souls')
      .upsert({ org_id: orgId, persona_context: merged }, { onConflict: 'org_id' })
      .select();
    return merged;
  }

  async updatePersonalProfile(orgId: string, patch: Partial<PersonalProfile>): Promise<PersonalProfile> {
    const row = await this.fetchSoul(orgId);
    const prefs = (row?.model_prefs ?? {}) as Record<string, unknown>;
    const current = (prefs['personal_profile'] ?? {}) as PersonalProfile;
    const merged = { ...current, ...patch };
    await this.db.admin
      .from('agent_souls')
      .upsert(
        { org_id: orgId, model_prefs: { ...prefs, personal_profile: merged } },
        { onConflict: 'org_id' },
      )
      .select();
    return merged;
  }

  /** Full context assembled in one DB round-trip. */
  async getAgentContext(orgId: string): Promise<AgentSoulContext> {
    const row = await this.fetchSoul(orgId);
    const prefs = (row?.model_prefs ?? {}) as {
      personal_profile?: PersonalProfile;
      cowork_context?: CoworkContext;
    };
    return {
      personal_profile: prefs.personal_profile ?? {},
      cowork_context: prefs.cowork_context ?? {},
      goals: (row?.goals ?? []) as Goal[],
      persona_context: (row?.persona_context ?? {}) as PersonaContext,
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
      .select('model_prefs, goals, persona_context')
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      this.logger.warn(`Could not read soul for org ${orgId}: ${error.message}`);
      return null;
    }
    return data as Record<string, unknown> | null;
  }
}
