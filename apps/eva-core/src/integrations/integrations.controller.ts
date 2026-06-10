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
import { RegisterWearDeviceDto } from './dto/register-wear-device.dto';
import { UpsertIntegrationDto } from './dto/upsert-integration.dto';
import { IntegrationsService } from './integrations.service';

enum KindParam {
  model = 'model',
  channel = 'channel',
  credential = 'credential',
}

@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Query('kind') kind?: 'model' | 'channel' | 'credential') {
    return this.integrations.list(req.user.orgId, kind);
  }

  @Get('channel/wear/overview')
  wearOverview(@Req() req: AuthenticatedRequest) {
    return this.integrations.getWearOverview(req.user.orgId);
  }

  @Post('channel/wear/devices')
  @HttpCode(HttpStatus.CREATED)
  registerWearDevice(@Body() dto: RegisterWearDeviceDto, @Req() req: AuthenticatedRequest) {
    return this.integrations.registerWearDevice({
      orgId: req.user.orgId,
      userId: req.user.userId,
      label: dto.label,
    });
  }

  @Post('credential/google/test')
  @HttpCode(HttpStatus.OK)
  testGoogle(@Req() req: AuthenticatedRequest) {
    return this.integrations.testGoogle(req.user.orgId);
  }

  @Post('credential/google/test/full')
  @HttpCode(HttpStatus.OK)
  testGoogleFull(@Req() req: AuthenticatedRequest) {
    return this.integrations.testGoogleFull(req.user.orgId);
  }

  @Post('model/:provider/test')
  @HttpCode(HttpStatus.OK)
  testModelProvider(@Param('provider') provider: string, @Req() req: AuthenticatedRequest) {
    return this.integrations.testModelProvider(req.user.orgId, provider);
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
