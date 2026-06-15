import { IsString, IsOptional } from 'class-validator';

export class MergeActionDto {
  @IsString()
  @IsOptional()
  reviewer_notes?: string;
}
