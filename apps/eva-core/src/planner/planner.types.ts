import { z } from 'zod';
import { Intent } from '../intent-router/intent-router.types';

// ── Zod schemas (single source of truth) ─────────────────────────────────────

export const PlanStepSchema = z.object({
  step:              z.number().int().positive(),
  description:       z.string().min(1).max(500),
  tool:              z.string().min(1),
  inputs:            z.record(z.string(), z.unknown()).default({}),
  requires_approval: z.boolean().default(false),
  estimated_tokens:  z.number().int().nonnegative().optional(),
});

export const PlanSchema = z.object({
  goal:                   z.string().min(1).max(1000),
  intent:                 z.enum(['fast_path', 'core_path', 'core_path_approval']),
  steps:                  z.array(PlanStepSchema).min(1).max(20),
  estimated_total_tokens: z.number().int().nonnegative().optional(),
  metadata:               z.record(z.string(), z.unknown()).optional(),
});

// ── TypeScript types inferred from Zod ───────────────────────────────────────

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Plan     = z.infer<typeof PlanSchema>;

// ── Request context for the planner ──────────────────────────────────────────

export interface PlanRequest {
  goal:     string;
  intent?:  Intent;   // auto-classified if omitted
  context?: string;
  orgId:    string;
}

// ── Tools the planner can suggest ────────────────────────────────────────────

export const KNOWN_TOOLS = [
  'code-executor',
  'web-search',
  'file-reader',
  'llm-generate',
  'memory-recall',
  'approval-gate',
  'data-query',
  'api-call',
] as const;

export type KnownTool = (typeof KNOWN_TOOLS)[number];
