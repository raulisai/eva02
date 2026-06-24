import { IsString, IsNotEmpty, IsOptional, MaxLength, IsBoolean, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class SuccessCriterionDto {
  id!: string;
  description!: string;
  verifiable!: boolean;
}

export class PreplanGoalDto {
  title!: string;
  description!: string;
  priority!: number;
  successCriteria!: SuccessCriterionDto[];
}

export class PreplanDto {
  northStar?: string;
  teamTier?: 'small' | 'medium' | 'large';
  teamTierReason?: string;
  definitionOfDone?: SuccessCriterionDto[];
  goals?: PreplanGoalDto[];
  repoName?: string;
  @IsBoolean()
  @IsOptional()
  autoApprove?: boolean;
}

export class CreateSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  prompt!: string;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  title?: string;

  @IsString()
  @IsOptional()
  project_id?: string;

  @IsOptional()
  preplan?: PreplanDto;
}
