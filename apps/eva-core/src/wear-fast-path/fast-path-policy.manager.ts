import { Injectable } from '@nestjs/common';
import {
  DEFAULT_FAST_PATH_POLICY,
  FastPathEvaluation,
  FastPathPolicy,
} from './wear-fast-path.types';

const DISALLOWED_TEXT_SIGNALS = [
  'uber',
  'buy',
  'purchase',
  'send money',
  'transfer',
  'whatsapp',
  'gmail',
  'claude code',
  'execute',
  'command',
  'deploy',
  'secret',
  'database',
  'memory',
  'delete',
  'update row',
  'insert row',
];

@Injectable()
export class FastPathPolicyManager {
  defaultPolicy(orgId: string): FastPathPolicy {
    const now = new Date().toISOString();
    return {
      id: 'default',
      org_id: orgId,
      created_at: now,
      updated_at: now,
      ...DEFAULT_FAST_PATH_POLICY,
    };
  }

  evaluate(input: {
    policy: FastPathPolicy;
    requestType: string;
    text: string;
  }): FastPathEvaluation {
    const requestType = input.requestType.toLowerCase();
    const text = input.text.toLowerCase();

    if (input.policy.disallowed.some(item => this.matches(item, requestType, text))) {
      return { allowed: false, reason: 'request_type_or_text_disallowed' };
    }

    if (DISALLOWED_TEXT_SIGNALS.some(signal => text.includes(signal))) {
      return { allowed: false, reason: 'sensitive_text_signal' };
    }

    if (!input.policy.allowed.includes(requestType)) {
      return { allowed: false, reason: 'request_type_not_allowed' };
    }

    return { allowed: true, reason: 'allowed_by_fast_path_policy' };
  }

  private matches(item: string, requestType: string, text: string): boolean {
    const normalized = item.toLowerCase();
    return requestType === normalized || text.includes(normalized.replace(/_/g, ' '));
  }
}
