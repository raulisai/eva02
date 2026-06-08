import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ResolveApprovalDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
