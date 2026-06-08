import { IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApprovalSource } from '../approval.types';

export class RequestApprovalDto {
  @IsOptional()
  @IsUUID()
  task_id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  action_type: string;

  @IsObject()
  payload: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3)
  level?: 0 | 1 | 2 | 3;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  screenshot_ref?: string;

  @IsOptional()
  @IsEnum(['core_path', 'fast_path', 'browser', 'dev_manager', 'system'])
  source?: ApprovalSource;

  @IsOptional()
  @IsString()
  expires_at?: string;
}
