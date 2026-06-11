import { Injectable } from '@nestjs/common';

const LEVEL_3 = [
  /\bdrop\s+database\b/i,
  /\bdrop\s+table\b/i,
  /\brotate\s+secret/i,
  /\bchange\s+dns\b/i,
  /\bdelete\s+production\b/i,
  /\breset\s+prod/i,
];

const LEVEL_2 = [
  /\bdeploy\b/i,
  /\bproduction\b/i,
  /\bmigration\b/i,
  /\bpayment\b/i,
  /\bpurchase\b/i,
  /\buber\b/i,
  /\bexternal_api\b/i,
  /\bdelete\b/i,
  /\bwrite_data\b/i,
  // Gmail destructive: move to trash or archive
  /^gmail\.(trash|archive)$/i,
  // Calendar: delete single event
  /^calendar\.delete$/i,
];

const LEVEL_1 = [
  /\bsend\b/i,
  /\bemail\b/i,
  /\bpost\b/i,
  /\bmessage\b/i,
  /\bbrowser\.(click|type)\b/i,
  // Gmail composition: send, reply, mark read/unread
  /^gmail\.(send|reply|mark_read|mark_unread)$/i,
  // Calendar: create or update event
  /^calendar\.(create|update)$/i,
];

@Injectable()
export class ApprovalClassifierService {
  classify(actionType: string, payload: Record<string, unknown>): 0 | 1 | 2 | 3 {
    const haystack = `${actionType} ${JSON.stringify(payload)}`;
    if (LEVEL_3.some((pattern) => pattern.test(haystack))) return 3;
    if (LEVEL_2.some((pattern) => pattern.test(haystack))) return 2;
    if (LEVEL_1.some((pattern) => pattern.test(haystack))) return 1;
    return 0;
  }

  isSensitive(actionType: string, payload: Record<string, unknown>): boolean {
    return this.classify(actionType, payload) > 0;
  }
}
