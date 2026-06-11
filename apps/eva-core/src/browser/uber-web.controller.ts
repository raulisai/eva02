import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { UberWebService } from '../integrations/uber-web.service';

@Controller('integrations/uber')
export class UberWebController {
  constructor(private readonly uber: UberWebService) {}

  @Get('status')
  async getStatus(@Req() req: AuthenticatedRequest) {
    const profile = await this.uber.getProfile(req.user.orgId);
    return {
      ok: true,
      has_session: profile.encrypted_state !== null,
    };
  }

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

  @Post('start-email-login')
  @HttpCode(HttpStatus.OK)
  startEmailLogin(
    @Body() body: { email: string; password?: string; task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const email = body?.email?.trim();
    const password = body?.password?.trim();
    if (!email) throw new BadRequestException('email is required');
    return this.uber.startEmailLogin(req.user.orgId, email, password, body?.task_id);
  }

  @Post('submit-login-code')
  @HttpCode(HttpStatus.OK)
  submitLoginCode(
    @Body() body: { code: string; task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const code = body?.code?.trim();
    if (!code) throw new BadRequestException('code is required');
    return this.uber.submitLoginCode(req.user.orgId, code, body?.task_id);
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
