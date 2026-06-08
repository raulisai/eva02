import { Controller, Post, Get, Body, Req, HttpCode, HttpStatus, Query, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { IntentRouterService } from './intent-router.service';
import { IntentRouterRepository } from './intent-router.repository';
import { ClassifyDto } from './dto/classify.dto';
import { AuthenticatedRequest } from '../common/types';

@Controller('intent')
export class IntentRouterController {
  constructor(
    private readonly intentRouter: IntentRouterService,
    private readonly repo: IntentRouterRepository,
  ) {}

  @Post('classify')
  @HttpCode(HttpStatus.OK)
  classify(@Body() dto: ClassifyDto, @Req() req: AuthenticatedRequest) {
    return this.intentRouter.classify(dto.input, req.user.orgId, {
      taskId:  dto.task_id,
      context: dto.context,
    });
  }

  @Get('routes')
  findRecent(
    @Req() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.repo.findRecent(req.user.orgId, Math.min(limit, 100));
  }
}
