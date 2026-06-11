import { Controller, Get, Req } from '@nestjs/common';
import { ModelRouterService } from './model-router.service';
import { AuthenticatedRequest } from '../common/types';

@Controller('billing')
export class ModelRouterController {
  constructor(private readonly modelRouterService: ModelRouterService) {}

  @Get('stats')
  async getStats(@Req() req: AuthenticatedRequest) {
    const { orgId } = req.user;
    return this.modelRouterService.getStats(orgId);
  }
}
