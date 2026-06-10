import { IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterWearDeviceDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  label!: string;
}
