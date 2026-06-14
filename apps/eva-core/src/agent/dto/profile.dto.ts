import { IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

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

export class UpdatePersonaFieldDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  key!: string;

  @IsString()
  @MaxLength(2000)
  value!: string;

  @IsOptional()
  @IsIn(['personal_profile', 'persona_context', 'cowork_context'])
  section?: 'personal_profile' | 'persona_context' | 'cowork_context';
}

export class CreatePlaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsOptional()
  @IsNumber()
  @Min(10)
  radius_m?: number;
}

export class UpdatePlaceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsOptional()
  @IsNumber()
  @Min(10)
  radius_m?: number;
}

export class AddRelationshipDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  display_name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  relation!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  contact_hint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
