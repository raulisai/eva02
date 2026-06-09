import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { LinkTelegramAccountDto, SendCommunicationDto } from './dto/communication.dto';
import { CommunicationService } from './communication.service';
import { TelegramWebhookUpdate } from './communication.types';
import { Public } from '../auth/public.decorator';

@Controller('communication')
export class CommunicationController {
  constructor(private readonly communication: CommunicationService) {}

  @Post('send')
  @HttpCode(HttpStatus.OK)
  send(@Body() dto: SendCommunicationDto, @Req() req: AuthenticatedRequest) {
    return this.communication.sendMessage({
      orgId: req.user.orgId,
      userId: req.user.userId,
      channel: dto.channel,
      target: dto.target,
      text: dto.text,
      notificationType: dto.notification_type,
      payload: dto.payload,
    });
  }

  @Post('telegram/link')
  @HttpCode(HttpStatus.OK)
  linkTelegram(@Body() dto: LinkTelegramAccountDto, @Req() req: AuthenticatedRequest) {
    return this.communication.linkTelegramAccount({
      orgId: req.user.orgId,
      userId: req.user.userId,
      telegramUserId: dto.telegram_user_id,
      chatId: dto.chat_id,
      displayName: dto.display_name,
    });
  }

  @Get('notifications')
  notifications(
    @Req() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.communication.findRecentNotifications(req.user.orgId, limit);
  }

  @Public()
  @Post('webhooks/telegram/:orgId')
  @HttpCode(HttpStatus.OK)
  telegramWebhook(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TelegramWebhookUpdate,
  ) {
    return this.communication.handleTelegramWebhook(orgId, secret, update);
  }
}
