import { IsString, MinLength, MaxLength } from 'class-validator';

export class SteerTaskDto {
  /** Live redirection message injected into a running task. */
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message!: string;
}
