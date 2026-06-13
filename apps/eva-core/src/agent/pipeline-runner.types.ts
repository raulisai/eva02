export interface PipelinePhase {
  /** Slug identifier, e.g. "create_report" */
  name: string;
  /** Complete sub-goal for this phase. May contain {{outputKey}} interpolations. */
  goal: string;
  /** Key under which this phase's output is stored in the pipeline context. */
  outputKey: string;
  /** Phase names that must complete before this phase can run. */
  dependsOn: string[];
  /** Agent-loop step budget for this phase. */
  maxSteps: number;
}

export interface PipelineDefinition {
  phases: PipelinePhase[];
}

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PhaseResult {
  name: string;
  status: PhaseStatus;
  output: string;
  error?: string;
  stepsUsed: number;
  tokensUsed: number;
  durationMs: number;
}

export interface PipelineOutcome {
  ok: boolean;
  /** Final answer text — last completed phase output + summary header on partial failure. */
  text: string;
  phases: PhaseResult[];
  totalTokens: number;
  totalSteps: number;
  durationMs: number;
}

export interface PipelineRunOptions {
  userId?: string;
  /** Outer context (conversation history, identity) prepended to every phase. */
  context?: string;
  log?: (message: string, scope: string) => Promise<unknown>;
}
