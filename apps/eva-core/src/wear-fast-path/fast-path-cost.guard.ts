import { Injectable } from '@nestjs/common';
import { FastPathPolicy, FastPathTotals } from './wear-fast-path.types';

@Injectable()
export class FastPathCostGuard {
  evaluate(input: {
    policy: FastPathPolicy;
    totals: FastPathTotals;
    estimatedTokens: number;
    estimatedCostUsd: number;
  }) {
    const nextSessionTokens = input.totals.sessionTokens + input.estimatedTokens;
    const nextDayTokens = input.totals.dayTokens + input.estimatedTokens;
    const nextSessionCost = input.totals.sessionCostUsd + input.estimatedCostUsd;
    const nextDayCost = input.totals.dayCostUsd + input.estimatedCostUsd;

    if (nextSessionTokens > input.policy.per_session_limit) {
      return { allowed: false, reason: 'session_token_limit_exceeded' };
    }
    if (nextDayTokens > input.policy.per_day_limit) {
      return { allowed: false, reason: 'day_token_limit_exceeded' };
    }
    if (nextSessionCost > input.policy.per_session_cost_limit_usd) {
      return { allowed: false, reason: 'session_cost_limit_exceeded' };
    }
    if (nextDayCost > input.policy.per_day_cost_limit_usd) {
      return { allowed: false, reason: 'day_cost_limit_exceeded' };
    }

    return { allowed: true, reason: 'within_cost_limits' };
  }
}
