import { IsArray, IsString, IsNotEmpty, ArrayMinSize } from 'class-validator';

export class ApproveGoalsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  goal_ids!: string[];
}
