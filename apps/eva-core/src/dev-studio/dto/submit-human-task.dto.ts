import { IsObject, IsString, IsOptional } from 'class-validator';

export class SubmitHumanTaskDto {
  @IsObject()
  result!: Record<string, unknown>;

  @IsString()
  @IsOptional()
  notes?: string;
}
