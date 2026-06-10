import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpsertIntegrationDto {
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(4096)
  secret?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}
