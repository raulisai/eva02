import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { ScheduledJobsService } from './scheduled-jobs.service';
import { CreateScheduledJobInput } from './scheduled-job.types';
import { AuthenticatedRequest } from '../common/types';

@Controller('jobs')
export class JobsController {
  constructor(private readonly svc: ScheduledJobsService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.svc.list(req.user.orgId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateScheduledJobInput,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.svc.create(dto, req.user.orgId, req.user.userId).then((job) => ({ job }));
  }

  @Get(':id')
  getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.svc.getById(id, req.user.orgId);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  pause(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.svc.pause(id, req.user.orgId).then((job) => ({ job }));
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.svc.resume(id, req.user.orgId).then((job) => ({ job }));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.svc.delete(id, req.user.orgId);
  }
}
