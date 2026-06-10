import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { CreateMcpConnectionDto, UpdateMcpConnectionDto } from './dto/create-mcp-connection.dto';
import { UpsertIntegrationDto } from './dto/upsert-integration.dto';
import { IntegrationsService } from './integrations.service';

enum KindParam {
  model = 'model',
  channel = 'channel',
}

@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Query('kind') kind?: 'model' | 'channel') {
    return this.integrations.list(req.user.orgId, kind);
  }

  @Get('mcp/connections')
  listMcp(@Req() req: AuthenticatedRequest) {
    return this.integrations.listMcp(req.user.orgId);
  }

  @Post('mcp/connections')
  @HttpCode(HttpStatus.CREATED)
  createMcp(@Body() dto: CreateMcpConnectionDto, @Req() req: AuthenticatedRequest) {
    return this.integrations.createMcp({
      orgId: req.user.orgId,
      name: dto.name,
      transport: dto.transport,
      endpoint: dto.endpoint,
      authToken: dto.auth_token,
      enabled: dto.enabled,
    });
  }

  @Patch('mcp/connections/:id')
  updateMcp(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMcpConnectionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.updateMcp(req.user.orgId, id, {
      enabled: dto.enabled,
      endpoint: dto.endpoint,
      authToken: dto.auth_token,
    });
  }

  @Post('mcp/connections/:id/test')
  @HttpCode(HttpStatus.OK)
  testMcp(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.integrations.testMcp(req.user.orgId, id);
  }

  @Delete('mcp/connections/:id')
  deleteMcp(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.integrations.deleteMcp(req.user.orgId, id);
  }

  @Post('channel/telegram/test')
  @HttpCode(HttpStatus.OK)
  testTelegram(@Req() req: AuthenticatedRequest) {
    return this.integrations.testTelegram(req.user.orgId);
  }

  @Post('channel/telegram/webhook')
  @HttpCode(HttpStatus.OK)
  registerTelegramWebhook(@Req() req: AuthenticatedRequest) {
    return this.integrations.registerTelegramWebhook(req.user.orgId);
  }

  @Put(':kind/:provider')
  upsert(
    @Param('kind', new ParseEnumPipe(KindParam)) kind: KindParam,
    @Param('provider') provider: string,
    @Body() dto: UpsertIntegrationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.upsert({
      orgId: req.user.orgId,
      kind,
      provider,
      secret: dto.secret,
      config: dto.config,
      status: dto.status,
      label: dto.label,
    });
  }

  @Delete(':kind/:provider')
  remove(
    @Param('kind', new ParseEnumPipe(KindParam)) kind: KindParam,
    @Param('provider') provider: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.remove(req.user.orgId, kind, provider);
  }
}
