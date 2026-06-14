/**
 * Budget policy — decides which model tier (cheap/balanced/powerful) each
 * decide-step of the agent loop should use.
 *
 * Rationale (token-smart, reasoning-aware):
 *  - Early steps of a complex task set the whole trajectory; spending a stronger
 *    model there is cheaper than wasting 5 steps recovering from a weak decision.
 *  - Failures climb the full ladder cheap→balanced→powerful, not just to balanced.
 *  - Sustained clean progress de-escalates, so trivial closing steps run cheap.
 *  - Phase floors: planning/synthesis deserve ≥ balanced; mechanical delivery may
 *    drop to cheap.
 *
 * Pure functions only — no I/O — so the policy is unit-testable in isolation.
 */
import { ModelBudget } from '../model-router/model-router.types';
import { Tier } from './tier';

/** Ordered ladder: index = strength rank. */
const LADDER: ModelBudget[] = ['cheap', 'balanced', 'powerful'];

export function budgetRank(b: ModelBudget): number {
  const r = LADDER.indexOf(b);
  return r < 0 ? 0 : r;
}

export function budgetFromRank(rank: number): ModelBudget {
  const clamped = Math.max(0, Math.min(LADDER.length - 1, rank));
  return LADDER[clamped];
}

/** Step phase inferred from where we are in the loop and what was just done. */
export type StepPhase = 'planning' | 'research' | 'synthesis' | 'delivery' | 'mechanical';

/** Reasons strong enough to jump straight toward `powerful` when repeated. */
const HARD_REASONS = new Set(['persistent_stall', 'dod_rejection', 'security_review']);

export interface BudgetState {
  budget: ModelBudget;
  reason: string;
  /** Count of "hard" escalation events so far (DoD/security/persistent stall). */
  hardEvents: number;
  /** Consecutive clean (non-error, non-rejected) steps since the last escalation. */
  cleanSuccesses: number;
}

/**
 * Initial budget for the first decide step, from task tier/complexity.
 * Complex work (long/medium, or anything with mandatory deliverables) starts at
 * `balanced` so the opening decisions — which steer the whole run — are sound.
 */
export function initialBudget(tier?: Tier, hasDeliverables = false): BudgetState {
  let budget: ModelBudget = 'cheap';
  let reason = 'initial-cheap';
  if (tier === 'long') {
    budget = 'balanced';
    reason = 'long-task-start';
  } else if (tier === 'medium' || hasDeliverables) {
    budget = 'balanced';
    reason = hasDeliverables ? 'deliverables-start' : 'medium-task-start';
  }
  return { budget, reason, hardEvents: 0, cleanSuccesses: 0 };
}

/**
 * Climb the ladder after a failure/escalation event.
 *  - First failure from cheap → balanced.
 *  - A hard reason, OR the 2nd+ hard event in a row → powerful.
 *  - parse_failure means the model literally can't emit valid JSON → climb a rung
 *    (a weak model that can't format won't fix itself by retrying at the same tier).
 */
export function escalateOnEvent(state: BudgetState, reason: string): BudgetState {
  const isHard = HARD_REASONS.has(reason);
  const hardEvents = isHard ? state.hardEvents + 1 : state.hardEvents;
  let rank = budgetRank(state.budget);

  if (isHard || hardEvents >= 2) {
    rank = budgetRank('powerful');
  } else if (rank < budgetRank('balanced')) {
    rank = budgetRank('balanced');
  } else if (reason === 'parse_failure' || reason === 'user_steer') {
    // parse_failure: a weak model that can't format won't fix itself at the same tier.
    // user_steer: a live user redirection deserves one stronger reasoning step.
    rank = Math.min(rank + 1, budgetRank('powerful'));
  }
  // else: already at balanced for a soft reason — hold (don't burn powerful yet).

  return { budget: budgetFromRank(rank), reason, hardEvents, cleanSuccesses: 0 };
}

/**
 * Step down one rung after sustained clean progress, so the easy tail of a run
 * doesn't keep paying for the strong model. Mechanical steps (pure delivery,
 * file ops) count double toward de-escalation since they need little reasoning.
 */
export function deescalateOnSuccess(
  state: BudgetState,
  opts: { phase: StepPhase; threshold?: number } = { phase: 'research' },
): BudgetState {
  const threshold = opts.threshold ?? 2;
  const increment = opts.phase === 'mechanical' || opts.phase === 'delivery' ? 2 : 1;
  const cleanSuccesses = state.cleanSuccesses + increment;

  if (cleanSuccesses >= threshold && budgetRank(state.budget) > 0) {
    return {
      budget: budgetFromRank(budgetRank(state.budget) - 1),
      reason: 'deescalate-clean-progress',
      hardEvents: state.hardEvents,
      cleanSuccesses: 0,
    };
  }
  return { ...state, cleanSuccesses };
}

/**
 * Infer the phase of the upcoming decide step from loop position and the last
 * tool used. Drives the per-step floor.
 */
export function inferPhase(
  stepIndex: number,
  maxSteps: number,
  lastTool: string | undefined,
  hasDeliveryPending: boolean,
): StepPhase {
  if (stepIndex === 0) return 'planning';
  const ratio = stepIndex / Math.max(maxSteps, 1);
  const DELIVERY_TOOLS = new Set(['telegram_send_file', 'gmail_write', 'whatsapp_send']);
  if (lastTool && DELIVERY_TOOLS.has(lastTool)) return 'delivery';
  // Near the end with a deliverable still pending → synthesis (assemble + deliver).
  if (hasDeliveryPending && ratio >= 0.5) return 'synthesis';
  if (ratio >= 0.6) return 'synthesis';
  if (ratio < 0.45) return 'research';
  return 'mechanical';
}

/**
 * Phase floor: synthesis steps assemble the final deliverable and need real
 * reasoning, so never let them run below `balanced` — this matters most when
 * de-escalation has walked the budget down to cheap near the end of a long run.
 *
 * The opening planning step is intentionally NOT floored: its budget already
 * comes from `initialBudget` (tier-aware), so a trivial lookup keeps cheap while
 * a long/medium task already opened at balanced.
 */
export function applyPhaseFloor(budget: ModelBudget, phase: StepPhase): { budget: ModelBudget; floored: boolean } {
  if (phase === 'synthesis') {
    const floored = budgetRank(budget) < budgetRank('balanced');
    return { budget: budgetFromRank(Math.max(budgetRank(budget), budgetRank('balanced'))), floored };
  }
  return { budget, floored: false };
}
