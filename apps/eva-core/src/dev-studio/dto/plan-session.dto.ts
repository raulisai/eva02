import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class PlanSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description!: string;
}
