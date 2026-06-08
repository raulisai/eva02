import { Controller, Post, Body, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { PlannerService } from './planner.service';
import { PlanRequestDto } from './dto/plan-request.dto';
import { AuthenticatedRequest } from '../common/types';

@Controller('planner')
export class PlannerController {
  constructor(private readonly planner: PlannerService) {}

  @Post('plan')
  @HttpCode(HttpStatus.OK)
  plan(@Body() dto: PlanRequestDto, @Req() req: AuthenticatedRequest) {
    return this.planner.plan({
      goal:    dto.goal,
      intent:  dto.intent,
      context: dto.context,
      orgId:   req.user.orgId,
    });
  }
}
