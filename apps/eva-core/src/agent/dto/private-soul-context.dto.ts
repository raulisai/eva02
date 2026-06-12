import { IsString, MaxLength } from 'class-validator';

export class PrivateSoulContextDto {
  @IsString()
  @MaxLength(12000)
  text!: string;
}
