import { IsEnum } from 'class-validator';
import { DevTaskStatus } from '../dev-control.types';

export class TransitionDevTaskDto {
  @IsEnum(['backlog', 'ready', 'in_progress', 'waiting_approval', 'testing', 'reviewing', 'done', 'failed', 'blocked'] as const)
  status: DevTaskStatus;
}
