import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import {
  AddRelationshipDto,
  ApplyProfileFactDto,
  CreatePlaceDto,
  CreatePrivateProfileItemDto,
  RevealPrivateProfileItemDto,
  UpdatePlaceDto,
  UpdatePersonaFieldDto,
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

  @Patch('persona')
  @HttpCode(HttpStatus.OK)
  updatePersonaField(@Body() dto: UpdatePersonaFieldDto, @Req() req: AuthenticatedRequest) {
    return this.facts.updatePersonaField(req.user.orgId, dto.key, dto.value, dto.section);
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

  @Delete('private-items/:id')
  @HttpCode(HttpStatus.OK)
  deletePrivateItem(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.facts.deletePrivateItem(req.user.orgId, id);
  }

  @Delete('todos/:id')
  @HttpCode(HttpStatus.OK)
  deleteTodo(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.facts.deleteTodo(req.user.orgId, id);
  }

  @Delete('notes/:id')
  @HttpCode(HttpStatus.OK)
  deleteNote(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.facts.deleteNote(req.user.orgId, id);
  }

  @Delete('goals/:id')
  @HttpCode(HttpStatus.OK)
  deleteGoal(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.facts.deleteGoal(req.user.orgId, id);
  }

  @Post('places')
  @HttpCode(HttpStatus.CREATED)
  addPlace(@Body() dto: CreatePlaceDto, @Req() req: AuthenticatedRequest) {
    return this.facts.addPlace(req.user.orgId, req.user.userId, dto);
  }

  @Patch('places/:id')
  @HttpCode(HttpStatus.OK)
  updatePlace(
    @Param('id') id: string,
    @Body() dto: UpdatePlaceDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.facts.updatePlace(req.user.orgId, id, dto);
  }

  @Delete('places/:id')
  @HttpCode(HttpStatus.OK)
  deletePlace(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.facts.deletePlace(req.user.orgId, id);
  }

  @Post('relationships')
  @HttpCode(HttpStatus.CREATED)
  addRelationship(@Body() dto: AddRelationshipDto, @Req() req: AuthenticatedRequest) {
    return this.facts.addRelationship(req.user.orgId, dto);
  }

  @Delete('relationships/:id')
  @HttpCode(HttpStatus.OK)
  removeRelationship(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.facts.removeRelationship(req.user.orgId, id);
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
