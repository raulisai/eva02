import {
  applyPhaseFloor,
  budgetFromRank,
  budgetRank,
  deescalateOnSuccess,
  escalateOnEvent,
  inferPhase,
  initialBudget,
  BudgetState,
} from '../budget-policy';

describe('budget-policy', () => {
  describe('ladder helpers', () => {
    it('maps budgets to ranks and back', () => {
      expect(budgetRank('cheap')).toBe(0);
      expect(budgetRank('balanced')).toBe(1);
      expect(budgetRank('powerful')).toBe(2);
      expect(budgetFromRank(0)).toBe('cheap');
      expect(budgetFromRank(2)).toBe('powerful');
    });

    it('clamps out-of-range ranks', () => {
      expect(budgetFromRank(-5)).toBe('cheap');
      expect(budgetFromRank(99)).toBe('powerful');
    });
  });

  describe('initialBudget', () => {
    it('starts long tasks at balanced', () => {
      expect(initialBudget('long').budget).toBe('balanced');
    });

    it('starts medium tasks at balanced', () => {
      expect(initialBudget('medium').budget).toBe('balanced');
    });

    it('starts a task with mandatory deliverables at balanced even if quick tier', () => {
      expect(initialBudget('quick', true).budget).toBe('balanced');
    });

    it('keeps chat/quick tasks cheap', () => {
      expect(initialBudget('chat').budget).toBe('cheap');
      expect(initialBudget('quick').budget).toBe('cheap');
      expect(initialBudget(undefined).budget).toBe('cheap');
    });
  });

  describe('escalateOnEvent', () => {
    const fresh = (budget: BudgetState['budget'] = 'cheap'): BudgetState => ({
      budget, reason: 'initial', hardEvents: 0, cleanSuccesses: 3,
    });

    it('climbs cheap → balanced on a soft failure', () => {
      const next = escalateOnEvent(fresh('cheap'), 'tool_error');
      expect(next.budget).toBe('balanced');
      expect(next.cleanSuccesses).toBe(0); // resets clean streak
    });

    it('holds at balanced for a single soft failure (does not burn powerful)', () => {
      const next = escalateOnEvent(fresh('balanced'), 'tool_error');
      expect(next.budget).toBe('balanced');
    });

    it('jumps straight to powerful on a hard reason (dod_rejection)', () => {
      const next = escalateOnEvent(fresh('cheap'), 'dod_rejection');
      expect(next.budget).toBe('powerful');
      expect(next.hardEvents).toBe(1);
    });

    it('reaches powerful after two hard events even from balanced', () => {
      let s = escalateOnEvent(fresh('cheap'), 'security_review'); // hard #1 → powerful
      expect(s.budget).toBe('powerful');
      s = escalateOnEvent({ ...s, budget: 'balanced' }, 'dod_rejection'); // hard #2
      expect(s.budget).toBe('powerful');
      expect(s.hardEvents).toBe(2);
    });

    it('climbs a rung on parse_failure (weak model cannot emit JSON)', () => {
      const next = escalateOnEvent(fresh('balanced'), 'parse_failure');
      expect(next.budget).toBe('powerful');
    });

    it('persistent_stall is treated as hard and reaches powerful', () => {
      const next = escalateOnEvent(fresh('cheap'), 'persistent_stall');
      expect(next.budget).toBe('powerful');
    });
  });

  describe('deescalateOnSuccess', () => {
    const at = (budget: BudgetState['budget'], cleanSuccesses = 0): BudgetState => ({
      budget, reason: 'x', hardEvents: 0, cleanSuccesses,
    });

    it('steps down after the threshold of clean research steps', () => {
      let s = deescalateOnSuccess(at('powerful'), { phase: 'research' });
      expect(s.budget).toBe('powerful'); // 1 < threshold(2)
      s = deescalateOnSuccess(s, { phase: 'research' });
      expect(s.budget).toBe('balanced'); // 2 → step down
    });

    it('mechanical steps count double and de-escalate in one step', () => {
      const s = deescalateOnSuccess(at('balanced'), { phase: 'mechanical' });
      expect(s.budget).toBe('cheap');
    });

    it('never goes below cheap', () => {
      const s = deescalateOnSuccess(at('cheap', 5), { phase: 'mechanical' });
      expect(s.budget).toBe('cheap');
    });
  });

  describe('inferPhase', () => {
    it('first step is planning', () => {
      expect(inferPhase(0, 10, undefined, false)).toBe('planning');
    });

    it('a delivery tool just ran → delivery phase', () => {
      expect(inferPhase(5, 10, 'telegram_send_file', false)).toBe('delivery');
    });

    it('late steps with a pending deliverable → synthesis', () => {
      expect(inferPhase(6, 10, 'web_search', true)).toBe('synthesis');
    });

    it('early steps are research', () => {
      expect(inferPhase(2, 10, 'web_search', false)).toBe('research');
    });

    it('late steps without deliverable → synthesis', () => {
      expect(inferPhase(8, 10, 'code_execute', false)).toBe('synthesis');
    });
  });

  describe('applyPhaseFloor', () => {
    it('raises cheap to balanced on synthesis', () => {
      expect(applyPhaseFloor('cheap', 'synthesis')).toEqual({ budget: 'balanced', floored: true });
    });

    it('does NOT floor planning (initialBudget already set it tier-aware)', () => {
      expect(applyPhaseFloor('cheap', 'planning')).toEqual({ budget: 'cheap', floored: false });
    });

    it('does not lower a strong budget on synthesis', () => {
      expect(applyPhaseFloor('powerful', 'synthesis')).toEqual({ budget: 'powerful', floored: false });
    });

    it('leaves research/mechanical/delivery untouched', () => {
      expect(applyPhaseFloor('cheap', 'research')).toEqual({ budget: 'cheap', floored: false });
      expect(applyPhaseFloor('cheap', 'mechanical')).toEqual({ budget: 'cheap', floored: false });
    });
  });

  describe('end-to-end token-smart trajectory', () => {
    it('long task: balanced start → powerful on DoD → de-escalates on clean tail', () => {
      // Start a long task
      let s = initialBudget('long');
      expect(s.budget).toBe('balanced');

      // DoD rejection mid-run → powerful
      s = escalateOnEvent(s, 'dod_rejection');
      expect(s.budget).toBe('powerful');

      // Three clean mechanical/delivery steps walk it back down
      s = deescalateOnSuccess(s, { phase: 'delivery' });   // +2 → powerful→balanced
      expect(s.budget).toBe('balanced');
      s = deescalateOnSuccess(s, { phase: 'mechanical' }); // +2 → balanced→cheap
      expect(s.budget).toBe('cheap');
    });
  });
});
