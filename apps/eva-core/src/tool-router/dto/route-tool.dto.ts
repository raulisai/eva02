import { IsString, IsOptional, IsEnum, IsNumber, Min, IsArray } from 'class-validator';
import { Type } from 'class-transformer';

export class RouteToolDto {
  @IsString()
  capability: string;

  @IsOptional()
  @IsEnum(['cheap', 'balanced', 'powerful'])
  budget?: 'cheap' | 'balanced' | 'powerful';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxLatencyMs?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludeTools?: string[];
}
