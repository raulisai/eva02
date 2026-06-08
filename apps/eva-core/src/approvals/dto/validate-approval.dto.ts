import { IsObject } from 'class-validator';

export class ValidateApprovalDto {
  @IsObject()
  payload: Record<string, unknown>;
}
