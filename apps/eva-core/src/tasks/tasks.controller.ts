import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { TransitionTaskDto } from './dto/transition-task.dto';
import { SteerTaskDto } from './dto/steer-task.dto';
import { AuthenticatedRequest } from '../common/types';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateTaskDto, @Req() req: AuthenticatedRequest) {
    const { userId, orgId } = req.user;
    return this.tasksService.createTask(dto, userId, orgId);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.tasksService.getTask(id, req.user.orgId);
  }

  @Post(':id/steer')
  @HttpCode(HttpStatus.ACCEPTED)
  steer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SteerTaskDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.tasksService.steer(id, req.user.orgId, dto.message);
  }

  @Patch(':id/status')
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionTaskDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.tasksService.transition(id, req.user.orgId, dto.status);
  }
}
