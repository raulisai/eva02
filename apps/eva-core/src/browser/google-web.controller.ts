import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
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

  /**
   * Import a Google session from cookies exported by the user's local browser.
   * Body: { cookies: <Cookie-Editor JSON array> | <Playwright StorageState> }
   * This is the server-safe alternative to manual browser login.
   */
  @Post('import-session')
  @HttpCode(HttpStatus.OK)
  importSession(
    @Body() body: { cookies: unknown },
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body?.cookies) throw new BadRequestException('cookies payload is required');
    return this.googleWeb.importSession(req.user.orgId, body.cookies);
  }
}
