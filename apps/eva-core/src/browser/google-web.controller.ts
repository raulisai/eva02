import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { GoogleWebLoginService } from '../integrations/google-web-login.service';

@Controller('integrations/google-web')
export class GoogleWebController {
  constructor(private readonly googleWeb: GoogleWebLoginService) {}

  @Post('start-session')
  @HttpCode(HttpStatus.OK)
  startSession(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.googleWeb.startSession(req.user.orgId, body?.task_id);
  }
}
