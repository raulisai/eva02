import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class ConnectRepoDto {
  /** Existing repo URL (https://github.com/owner/repo). Required unless `create` is true. */
  @IsString()
  @IsOptional()
  @MaxLength(300)
  repoUrl?: string;

  /** When true, EVA creates a new GitHub repo instead of connecting an existing one. */
  @IsBoolean()
  @IsOptional()
  create?: boolean;

  /** New repo name (used when `create` is true; defaults to a slug of the session title). */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  /** Optional GitHub org/owner to create the repo under (defaults to the token's user). */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  owner?: string;

  /** Whether a created repo is private (default true). */
  @IsBoolean()
  @IsOptional()
  private?: boolean;
}
