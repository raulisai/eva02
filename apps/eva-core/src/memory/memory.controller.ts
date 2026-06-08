import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Param,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { MemoryService } from './memory.service';
import { MemoryAgentService } from './memory-agent.service';
import { SaveMemoryDto } from './dto/save-memory.dto';
import { SearchMemoryDto } from './dto/search-memory.dto';
import { AuthenticatedRequest } from '../common/types';

@Controller('memories')
export class MemoryController {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly memoryAgentService: MemoryAgentService,
  ) {}

  // Agent Fast Path: POST /memories
  // Accepts a pre-computed summary; Core decides whether to persist.
  @Post()
  @HttpCode(HttpStatus.CREATED)
  save(@Body() dto: SaveMemoryDto, @Req() req: AuthenticatedRequest) {
    return this.memoryService.saveMemory(dto, req.user.orgId);
  }

  // Semantic search: POST /memories/search
  @Post('search')
  @HttpCode(HttpStatus.OK)
  search(@Body() dto: SearchMemoryDto, @Req() req: AuthenticatedRequest) {
    return this.memoryService.searchMemories(dto, req.user.orgId);
  }

  // Agent recall: POST /memories/recall  (convenience; same as search)
  @Post('recall')
  @HttpCode(HttpStatus.OK)
  recall(@Body() dto: SearchMemoryDto, @Req() req: AuthenticatedRequest) {
    return this.memoryAgentService.recall(
      dto.query,
      req.user.orgId,
      dto.limit,
      dto.threshold,
    );
  }

  // GET /memories/:id
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.memoryService.getMemory(id, req.user.orgId);
  }
}
