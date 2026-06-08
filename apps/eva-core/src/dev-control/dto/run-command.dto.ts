import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class RunCommandDto {
  @IsUUID()
  project_id: string;

  @IsOptional()
  @IsUUID()
  dev_task_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  command?: string;
}
