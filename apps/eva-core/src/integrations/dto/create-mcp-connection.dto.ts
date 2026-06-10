import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class CreateMcpConnectionDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsIn(['http', 'sse', 'stdio'])
  transport!: 'http' | 'sse' | 'stdio';

  @IsString()
  @MaxLength(2048)
  endpoint!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  auth_token?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateMcpConnectionDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  endpoint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  auth_token?: string;
}
