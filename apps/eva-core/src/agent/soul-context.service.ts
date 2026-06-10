import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface PersonalProfile {
  full_name?: string;
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

  async resolveCurrentLocation(orgId: string): Promise<string | null> {
    const profile = await this.getPersonalProfile(orgId);
    return profile.current_location?.trim()
      || profile.address?.trim()
      || null;
  }
}
