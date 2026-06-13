import { IsEnum } from 'class-validator';
import { TaskStatus } from '../task.types';

export class TransitionTaskDto {
  @IsEnum(['pending', 'planning', 'running', 'waiting_for_approval', 'waiting_for_input', 'completed', 'failed', 'cancelled'] as const)
  status!: TaskStatus;
}
