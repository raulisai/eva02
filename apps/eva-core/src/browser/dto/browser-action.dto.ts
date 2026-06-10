import { IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class OpenBrowserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  service: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  url: string;

  @IsOptional()
  @IsUUID()
  task_id?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  reuse_open?: boolean;
}

export class SelectorDto {
  @IsUUID()
  task_id: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  selector: string;
}

export class TypeBrowserDto extends SelectorDto {
  @IsString()
  @MaxLength(4000)
  text: string;
}

export class ExtractBrowserDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  selector?: string;
}

export class WaitBrowserDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30000)
  ms: number;
}

export class PrepareBrowserActionDto {
  @IsUUID()
  task_id: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  action_type: 'browser.click' | 'browser.type';

  @IsObject()
  payload: Record<string, unknown>;
}
