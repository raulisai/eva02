import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface PersonalProfile {
  full_name?: string;
  preferred_address?: string;
  age?: string;
  likes?: string;
  dislikes?: string;
  allergies?: string;
  address?: string;
  current_location?: string;
  weight?: string;
  height?: string;
  workplace?: string;
}

export interface CoworkContext {
  calendars?: string;
  upcoming_appointments?: string;
  pending_tasks?: string;
  work_hours?: string;
  days_off?: string;
  goals?: string;
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
}

@Injectable()
export class SoulContextService {
  private readonly logger = new Logger(SoulContextService.name);

  constructor(private readonly db: DatabaseService) {}

  async getPersonalProfile(orgId: string): Promise<PersonalProfile> {
    const { data, error } = await this.db.admin
      .from('agent_souls')
      .select('model_prefs')
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      this.logger.warn(`Could not read soul profile for org ${orgId}: ${error.message}`);
      return {};
    }

    const prefs = (data?.model_prefs ?? {}) as { personal_profile?: PersonalProfile };
    return prefs.personal_profile ?? {};
  }

  async getCoworkContext(orgId: string): Promise<CoworkContext> {
    const { data, error } = await this.db.admin
      .from('agent_souls')
      .select('model_prefs')
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      this.logger.warn(`Could not read cowork context for org ${orgId}: ${error.message}`);
      return {};
    }

    const prefs = (data?.model_prefs ?? {}) as { cowork_context?: CoworkContext };
    return prefs.cowork_context ?? {};
  }

  async getAgentContext(orgId: string): Promise<AgentSoulContext> {
    const { data, error } = await this.db.admin
      .from('agent_souls')
      .select('model_prefs')
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      this.logger.warn(`Could not read agent context for org ${orgId}: ${error.message}`);
      return { personal_profile: {}, cowork_context: {} };
    }

    const prefs = (data?.model_prefs ?? {}) as {
      personal_profile?: PersonalProfile;
      cowork_context?: CoworkContext;
    };
    return {
      personal_profile: prefs.personal_profile ?? {},
      cowork_context: prefs.cowork_context ?? {},
    };
  }

  async resolveCurrentLocation(orgId: string): Promise<string | null> {
    const profile = await this.getPersonalProfile(orgId);
    return profile.current_location?.trim()
      || profile.address?.trim()
      || null;
  }
}
