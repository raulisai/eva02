import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { UberWebService } from '../integrations/uber-web.service';

@Controller('integrations/uber')
export class UberWebController {
  constructor(private readonly uber: UberWebService) {}

  @Post('start-session')
  @HttpCode(HttpStatus.OK)
  startSession(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.uber.startSession(req.user.orgId, body?.task_id);
  }

  @Post('start-google-login')
  @HttpCode(HttpStatus.OK)
  startGoogleLogin(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.uber.startGoogleLogin(req.user.orgId, body?.task_id);
  }

  @Post('estimate')
  @HttpCode(HttpStatus.OK)
  estimate(
    @Body() body: { origin: string; destination: string; task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const origin = body?.origin?.trim();
    const destination = body?.destination?.trim();
    if (!origin || !destination) {
      throw new BadRequestException('origin and destination are required');
    }
    return this.uber.estimateRide(req.user.orgId, {
      origin,
      destination,
      taskId: body.task_id,
    });
  }
}
