import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class IssueWearTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  device_id: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;
}

export class FastPathRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  device_id: string;

  @IsOptional()
  @IsUUID()
  session_id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  request_type: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  input: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(500)
  estimated_tokens?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10)
  estimated_cost_usd?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(120000)
  latency_ms?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateFastPathPolicyDto {
  @IsOptional()
  allowed?: string[];

  @IsOptional()
  disallowed?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  per_session_limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  per_day_limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  per_session_cost_limit_usd?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1000)
  per_day_cost_limit_usd?: number;
}
