import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class AgentFeedbackDto {
  @IsUUID()
  taskId!: string;

  @IsEnum(['positive', 'negative', 'neutral'] as const)
  @IsOptional()
  reaction?: 'positive' | 'negative' | 'neutral';

  @IsInt()
  @Min(1)
  @Max(5)
  @IsOptional()
  rating?: number;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  comment?: string;
}
