import { Injectable } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { SaveMemoryDto } from './dto/save-memory.dto';
import { SearchMemoryDto } from './dto/search-memory.dto';
import { Memory, MemoryResult, MemorySearchResult } from './memory.types';

// Agent-facing façade: ingest() + recall() are the two public verbs.
// Agents never touch MemoryService or MemoriesRepository directly.
@Injectable()
export class MemoryAgentService {
  constructor(private readonly memoryService: MemoryService) {}

  async ingest(dto: SaveMemoryDto, orgId: string): Promise<MemoryResult> {
    return this.memoryService.saveMemory(dto, orgId);
  }

  async recall(query: string, orgId: string, limit = 5, threshold = 0.7): Promise<MemorySearchResult[]> {
    const dto = new SearchMemoryDto();
    dto.query = query;
    dto.limit = limit;
    dto.threshold = threshold;
    return this.memoryService.searchMemories(dto, orgId);
  }

  async get(memoryId: string, orgId: string): Promise<Memory> {
    return this.memoryService.getMemory(memoryId, orgId);
  }
}
