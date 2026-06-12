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

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.whatsapp.validateSession(req.user.orgId, body?.task_id);
  }

  @Post('test-screenshot')
  @HttpCode(HttpStatus.OK)
  testScreenshot(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.whatsapp.captureSessionScreenshot(req.user.orgId, body?.task_id);
  }

  @Post('latest-message')
  @HttpCode(HttpStatus.OK)
  latestMessage(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.whatsapp.fetchLatestMessage(req.user.orgId, body?.task_id);
  }

  @Post('unread-messages')
  @HttpCode(HttpStatus.OK)
  unreadMessages(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.whatsapp.fetchUnreadMessages(req.user.orgId, body?.task_id);
  }

  @Post('unanswered-messages')
  @HttpCode(HttpStatus.OK)
  unansweredMessages(
    @Body() body: { task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.whatsapp.fetchUnansweredMessages(req.user.orgId, body?.task_id);
  }

  @Post('send-message')
  @HttpCode(HttpStatus.OK)
  sendMessage(
    @Body() body: { contact: string; message: string; task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.whatsapp.sendMessage(req.user.orgId, body.contact, body.message, body?.task_id);
  }

  @Post('contact-messages')
  @HttpCode(HttpStatus.OK)
  contactMessages(
    @Body() body: { contact: string; task_id?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.whatsapp.fetchContactMessages(req.user.orgId, body.contact, body?.task_id);
  }
}
