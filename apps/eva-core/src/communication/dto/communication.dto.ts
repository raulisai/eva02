import { IsEnum, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CommunicationChannel } from '../communication.types';

export class SendCommunicationDto {
  @IsEnum(['telegram', 'discord', 'email', 'push', 'dashboard'])
  channel: CommunicationChannel;

  @IsObject()
  target: Record<string, unknown>;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  notification_type?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

export class LinkTelegramAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  telegram_user_id: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  chat_id: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  display_name?: string;
}
