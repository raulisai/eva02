import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { RappiWebService } from '../integrations/rappi-web.service';

@Controller('integrations/rappi')
export class RappiWebController {
  constructor(private readonly rappi: RappiWebService) {}

  @Post('start-session')
  @HttpCode(HttpStatus.OK)
  startSession(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.rappi.startSession(req.user.orgId, body?.task_id);
  }

  @Post('start-email-login')
  @HttpCode(HttpStatus.OK)
  startEmailLogin(
    @Body() body: { email: string; task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const email = body?.email?.trim();
    if (!email) throw new BadRequestException('email is required');
    return this.rappi.startEmailLogin(req.user.orgId, email, body?.task_id);
  }

  @Post('submit-login-code')
  @HttpCode(HttpStatus.OK)
  submitLoginCode(
    @Body() body: { code: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const code = body?.code?.trim();
    if (!code) throw new BadRequestException('code is required');
    return this.rappi.submitLoginCode(req.user.orgId, code);
  }
}
