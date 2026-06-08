import { IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class StartClaudeSessionDto {
  @IsUUID()
  project_id: string;

  @IsOptional()
  @IsUUID()
  dev_task_id?: string;

  @IsOptional()
  @IsString()
  node_id?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class SendClaudeTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(12000)
  prompt: string;

  @IsOptional()
  @IsUUID()
  approval_id?: string;
}
