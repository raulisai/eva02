import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { FastPathRequestDto, IssueWearTokenDto, UpdateFastPathPolicyDto } from './dto/wear-fast-path.dto';
import { WearFastPathService } from './wear-fast-path.service';

@Controller('wear-fast-path')
export class WearFastPathController {
  constructor(private readonly service: WearFastPathService) {}

  @Post('token')
  @HttpCode(HttpStatus.CREATED)
  issueToken(@Body() dto: IssueWearTokenDto, @Req() req: AuthenticatedRequest) {
    return this.service.issueToken({
      orgId: req.user.orgId,
      userId: req.user.userId,
      deviceId: dto.device_id,
      model: dto.model,
    });
  }

  @Post('request')
  @HttpCode(HttpStatus.OK)
  handleRequest(@Body() dto: FastPathRequestDto, @Req() req: AuthenticatedRequest) {
    return this.service.handleRequest({
      orgId: req.user.orgId,
      userId: req.user.userId,
      deviceId: dto.device_id,
      sessionId: dto.session_id,
      requestType: dto.request_type,
      text: dto.input,
      model: dto.model,
      estimatedTokens: dto.estimated_tokens,
      estimatedCostUsd: dto.estimated_cost_usd,
      latencyMs: dto.latency_ms,
      metadata: dto.metadata,
    });
  }

  @Get('policy')
  getPolicy(@Req() req: AuthenticatedRequest) {
    return this.service.getPolicy(req.user.orgId);
  }

  @Patch('policy')
  updatePolicy(@Body() dto: UpdateFastPathPolicyDto, @Req() req: AuthenticatedRequest) {
    return this.service.updatePolicy(req.user.orgId, dto);
  }
}
