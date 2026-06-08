import { IsString, IsOptional, IsEnum, MinLength, MaxLength } from 'class-validator';

export class PlanRequestDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  goal: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  context?: string;

  @IsOptional()
  @IsEnum(['fast_path', 'core_path', 'core_path_approval'])
  intent?: 'fast_path' | 'core_path' | 'core_path_approval';
}
