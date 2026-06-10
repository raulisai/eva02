import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { WhatsAppWebService } from '../integrations/whatsapp-web.service';

@Controller('integrations/whatsapp')
export class WhatsAppWebController {
  constructor(private readonly whatsapp: WhatsAppWebService) {}

  @Post('start-session')
  @HttpCode(HttpStatus.OK)
  startSession(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.whatsapp.startSession(req.user.orgId, body?.task_id);
  }

  @Post('latest-message')
  @HttpCode(HttpStatus.OK)
  latestMessage(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.whatsapp.fetchLatestMessage(req.user.orgId, body?.task_id);
  }
}
