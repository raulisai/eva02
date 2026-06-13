import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import {
  ApplyProfileFactDto,
  CreatePrivateProfileItemDto,
  RevealPrivateProfileItemDto,
} from './dto/profile.dto';
import { ProfileFactsService } from './profile-facts.service';

@Controller('agent/profile')
export class ProfileController {
  constructor(private readonly facts: ProfileFactsService) {}

  @Get('overview')
  getOverview(@Req() req: AuthenticatedRequest) {
    return this.facts.getOverview(req.user.orgId);
  }

  @Post('facts')
  @HttpCode(HttpStatus.OK)
  applyFact(@Body() dto: ApplyProfileFactDto, @Req() req: AuthenticatedRequest) {
    return this.facts.applyFact(req.user.orgId, req.user.userId, dto);
  }

  @Post('private-items')
  @HttpCode(HttpStatus.CREATED)
  createPrivateItem(@Body() dto: CreatePrivateProfileItemDto, @Req() req: AuthenticatedRequest) {
    return this.facts.createPrivateItem(req.user.orgId, req.user.userId, dto);
  }

  @Post('private-items/:id/reveal')
  @HttpCode(HttpStatus.OK)
  revealPrivateItem(
    @Param('id') id: string,
    @Body() dto: RevealPrivateProfileItemDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.facts.revealPrivateItem(req.user.orgId, req.user.userId, id, dto.reason);
  }

  @Post('suggestions/:id/accept')
  @HttpCode(HttpStatus.OK)
  acceptSuggestion(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.facts.acceptSuggestion(req.user.orgId, req.user.userId, id);
  }

  @Post('suggestions/:id/dismiss')
  @HttpCode(HttpStatus.OK)
  dismissSuggestion(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.facts.dismissSuggestion(req.user.orgId, id);
  }
}
