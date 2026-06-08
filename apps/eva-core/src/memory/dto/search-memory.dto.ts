import { IsString, IsOptional, IsNumber, Min, Max, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class SearchMemoryDto {
  @IsString()
  @MinLength(3)
  query: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(20)
  limit?: number = 5;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  threshold?: number = 0.7;
}
