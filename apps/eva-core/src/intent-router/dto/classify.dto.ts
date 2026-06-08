import { IsString, IsOptional, IsUUID, MinLength, MaxLength } from 'class-validator';

export class ClassifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  input: string;

  @IsOptional()
  @IsUUID()
  task_id?: string;

  @IsOptional()
  @IsString()
  context?: string;
}
