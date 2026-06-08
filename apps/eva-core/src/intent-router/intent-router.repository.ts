import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { IntentRoute, Intent, ClassifierKind } from './intent-router.types';

export interface CreateRouteData {
  org_id:     string;
  task_id?:   string;
  input:      string;
  intent:     Intent;
  confidence: number;
  classifier: ClassifierKind;
  metadata:   Record<string, unknown>;
}

@Injectable()
export class IntentRouterRepository {
  private readonly logger = new Logger(IntentRouterRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async record(data: CreateRouteData): Promise<IntentRoute> {
    const input_hash = createHash('sha256').update(data.input).digest('hex');

    const { data: row, error } = await this.db.admin
      .from('intent_routes')
      .insert({
        org_id:     data.org_id,
        task_id:    data.task_id ?? null,
        input_hash,
        intent:     data.intent,
        confidence: data.confidence,
        classifier: data.classifier,
        metadata:   data.metadata,
      })
      .select()
      .single();

    if (error) {
      this.logger.error('intent_routes.record', error);
      throw new InternalServerErrorException('Failed to record intent route');
    }
    return row as IntentRoute;
  }

  async findRecent(orgId: string, limit = 20): Promise<IntentRoute[]> {
    const { data, error } = await this.db.admin
      .from('intent_routes')
      .select('*')
      .eq('org_id', orgId)       // mandatory org filter
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      this.logger.error('intent_routes.findRecent', error);
      throw new InternalServerErrorException('Failed to fetch intent routes');
    }
    return (data ?? []) as IntentRoute[];
  }
}
