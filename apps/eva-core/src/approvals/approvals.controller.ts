import { Body, Controller, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuthenticatedRequest } from '../common/types';
import { ApprovalsService } from './approvals.service';
import { RequestApprovalDto } from './dto/request-approval.dto';
import { ResolveApprovalDto } from './dto/resolve-approval.dto';
import { ValidateApprovalDto } from './dto/validate-approval.dto';

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post('request')
  request(@Body() dto: RequestApprovalDto, @Req() req: AuthenticatedRequest) {
    return this.approvals.request(dto, req.user.orgId, req.user.userId);
  }

  @Post(':id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest) {
    return this.approvals.approve(id, req.user.orgId, req.user.userId);
  }

  @Post(':id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveApprovalDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.approvals.reject(id, req.user.orgId, req.user.userId, dto.reason);
  }

  @Post(':id/validate')
  validate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ValidateApprovalDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.approvals.validateForExecution(id, req.user.orgId, dto.payload);
  }
}
