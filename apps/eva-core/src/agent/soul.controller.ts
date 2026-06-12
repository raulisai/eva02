import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { PrivateSoulContextDto } from './dto/private-soul-context.dto';
import { SoulContextService } from './soul-context.service';

@Controller('agent/soul')
export class SoulController {
  constructor(private readonly soul: SoulContextService) {}

  @Post('private-context')
  @HttpCode(HttpStatus.OK)
  async savePrivateContext(
    @Body() dto: PrivateSoulContextDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ private_context_hint: string }> {
    return this.soul.savePrivateUserContext(req.user.orgId, dto.text);
  }
}
