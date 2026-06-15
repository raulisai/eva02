import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class SteerSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  message!: string;
}
