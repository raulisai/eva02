import { IsString, IsOptional, IsEnum, IsObject, IsUUID, MinLength, MaxLength } from 'class-validator';
import { MemoryType } from '../memory.types';

export class SaveMemoryDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  summary: string;

  @IsString()
  @MinLength(1)
  content: string;

  @IsOptional()
  @IsString()
  agent_id?: string;

  @IsOptional()
  @IsUUID()
  task_id?: string;

  @IsOptional()
  @IsEnum(['episodic', 'semantic', 'procedural', 'working'])
  memory_type?: MemoryType;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
