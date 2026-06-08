import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashApprovalAction(input: {
  actionType: string;
  payload: Record<string, unknown>;
  nonce: string;
  expiresAt: string;
}): string {
  return createHash('sha256')
    .update(input.actionType)
    .update('\n')
    .update(canonicalJson(input.payload))
    .update('\n')
    .update(input.nonce)
    .update('\n')
    .update(input.expiresAt)
    .digest('hex');
}
