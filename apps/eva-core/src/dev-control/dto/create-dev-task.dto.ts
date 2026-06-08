import { IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateDevTaskDto {
  @IsUUID()
  project_id: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(12000)
  prompt?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
