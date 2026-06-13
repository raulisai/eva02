import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePrivateProfileItemDto {
  @IsString()
  @MaxLength(60)
  kind!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(12000)
  value!: string;
}

export class RevealPrivateProfileItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  reason?: string;
}

export class ApplyProfileFactDto {
  @IsIn(['todo', 'note', 'goal', 'profile_field', 'suggestion'])
  type!: 'todo' | 'note' | 'goal' | 'profile_field' | 'suggestion';

  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  source?: string;

  @IsOptional()
  evidenceTaskId?: string;
}
