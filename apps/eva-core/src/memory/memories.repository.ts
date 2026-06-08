import { Injectable, NotFoundException, InternalServerErrorException, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Memory, MemoryEmbedding, MemorySearchResult, MemoryType } from './memory.types';

export interface CreateMemoryData {
  org_id: string;
  agent_id?: string;
  task_id?: string;
  content: string;
  summary: string;
  importance: number;
  memory_type: MemoryType;
  metadata: Record<string, unknown>;
}

@Injectable()
export class MemoriesRepository {
  private readonly logger = new Logger(MemoriesRepository.name);

  constructor(private readonly db: DatabaseService) {}

  async create(data: CreateMemoryData): Promise<Memory> {
    const { data: row, error } = await this.db.admin
      .from('memories')
      .insert({
        org_id: data.org_id,
        agent_id: data.agent_id ?? null,
        task_id: data.task_id ?? null,
        content: data.content,
        summary: data.summary,
        importance: data.importance,
        memory_type: data.memory_type,
        metadata: data.metadata,
      })
      .select()
      .single();

    if (error) {
      this.logger.error('memories.create', error);
      throw new InternalServerErrorException('Failed to create memory');
    }
    return row as Memory;
  }

  async findById(memoryId: string, orgId: string): Promise<Memory | null> {
    const { data, error } = await this.db.admin
      .from('memories')
      .select('*')
      .eq('id', memoryId)
      .eq('org_id', orgId)   // mandatory org filter
      .maybeSingle();

    if (error) {
      this.logger.error('memories.findById', error);
      throw new InternalServerErrorException('Failed to fetch memory');
    }
    return data as Memory | null;
  }

  async findByIdOrThrow(memoryId: string, orgId: string): Promise<Memory> {
    const memory = await this.findById(memoryId, orgId);
    if (!memory) throw new NotFoundException(`Memory ${memoryId} not found`);
    return memory;
  }

  async storeEmbedding(
    memoryId: string,
    orgId: string,
    embedding: number[],
    model: string,
  ): Promise<MemoryEmbedding> {
    const { data, error } = await this.db.admin
      .from('memory_embeddings')
      .upsert(
        { memory_id: memoryId, org_id: orgId, embedding: embedding as unknown as string, model },
        { onConflict: 'memory_id,model' },
      )
      .select()
      .single();

    if (error) {
      this.logger.error('memories.storeEmbedding', error);
      throw new InternalServerErrorException('Failed to store embedding');
    }
    return data as unknown as MemoryEmbedding;
  }

  async searchSimilar(
    queryEmbedding: number[],
    orgId: string,
    limit: number,
    threshold: number,
  ): Promise<MemorySearchResult[]> {
    const { data, error } = await this.db.admin.rpc('match_memories', {
      query_embedding: queryEmbedding as unknown as string,
      match_org_id: orgId,
      match_count: limit,
      match_threshold: threshold,
    });

    if (error) {
      this.logger.error('memories.searchSimilar', error);
      throw new InternalServerErrorException('Failed to search memories');
    }
    return (data ?? []) as MemorySearchResult[];
  }

  async updateAccessedAt(memoryId: string, orgId: string): Promise<void> {
    const { error } = await this.db.admin
      .from('memories')
      .update({ accessed_at: new Date().toISOString() })
      .eq('id', memoryId)
      .eq('org_id', orgId);   // mandatory org filter

    if (error) {
      this.logger.error('memories.updateAccessedAt', error);
    }
  }
}
