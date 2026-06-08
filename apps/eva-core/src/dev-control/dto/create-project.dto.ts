import { IsArray, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  repo_path?: string;

  @IsOptional()
  @IsString()
  node_id?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  stack?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  main_branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  dev_command?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  test_command?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  build_command?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
