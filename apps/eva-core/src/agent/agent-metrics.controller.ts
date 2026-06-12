import { Controller, Get, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { AgentTrajectoryService } from './agent-trajectory.service';

@Controller('agent')
export class AgentMetricsController {
  constructor(private readonly trajectories: AgentTrajectoryService) {}

  @Get('metrics')
  metrics(@Req() req: AuthenticatedRequest) {
    return this.trajectories.metrics(req.user.orgId);
  }
}
