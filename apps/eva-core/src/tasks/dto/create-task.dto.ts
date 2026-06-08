import { IsString, IsNotEmpty, IsOptional, MaxLength, IsObject } from 'class-validator';

export class CreateTaskDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @IsString()
  @IsOptional()
  @MaxLength(4000)
  description?: string;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
