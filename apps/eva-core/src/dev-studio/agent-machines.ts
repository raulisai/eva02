import type { AgentRole } from './dev-studio.types';

/**
 * Per-role machine spec for Dev Studio agents.
 *
 * Every agent boots its own Docker container when it registers for a session.
 * Code roles (backend/frontend/testing) get a dedicated pre-baked image with
 * their toolchain; analysis roles (architect/PM/reviewer/deployment) share the
 * lightweight base image — they still boot a real, inspectable machine, but
 * don't need the heavy dev stacks.
 *
 * Image resolution order (first that exists wins, see ClaudeCodeRunnerService):
 *   1. env override  EVA_AGENT_IMAGE_<ROLE>
 *   2. the role's default image (below)
 *   3. the base image (EVA_AGENT_BASE_IMAGE / eva-agent-base)
 *   4. legacy  EVA_CLAUDE_SANDBOX_IMAGE / eva-claude-sandbox
 */
export interface AgentMachineSpec {
  /** Default image tag (overridable via env). */
  image: string;
  /** Memory limit passed to `docker run --memory`. */
  memory: string;
  /** CPU limit passed to `docker run --cpus`. */
  cpus: string;
  /** Short human label of what's pre-installed (shown in the UI). */
  toolingLabel: string;
}

const BASE_IMAGE = process.env.EVA_AGENT_BASE_IMAGE || 'eva-agent-base';

/** Legacy single image, kept as the final fallback for back-compat. */
export const LEGACY_IMAGE = process.env.EVA_CLAUDE_SANDBOX_IMAGE || 'eva-claude-sandbox';

const BASE_TOOLING = 'claude · git · ripgrep · jq';

const SPECS: Record<AgentRole, AgentMachineSpec> = {
  backend: {
    image: process.env.EVA_AGENT_IMAGE_BACKEND || 'eva-agent-backend',
    memory: '3g',
    cpus: '2',
    toolingLabel: `${BASE_TOOLING} · python · php · go · postgres-client`,
  },
  frontend: {
    image: process.env.EVA_AGENT_IMAGE_FRONTEND || 'eva-agent-frontend',
    memory: '3g',
    cpus: '2',
    toolingLabel: `${BASE_TOOLING} · pnpm · yarn · next · vite · typescript`,
  },
  // Single dev for simple projects — needs both backend and frontend toolchains;
  // the backend image already ships node (base) + python/php/go.
  full_stack: {
    image: process.env.EVA_AGENT_IMAGE_FULL_STACK || 'eva-agent-backend',
    memory: '4g',
    cpus: '2',
    toolingLabel: `${BASE_TOOLING} · node · python · php · go · postgres-client`,
  },
  testing: {
    image: process.env.EVA_AGENT_IMAGE_TESTING || 'eva-agent-testing',
    memory: '4g',
    cpus: '2',
    toolingLabel: `${BASE_TOOLING} · playwright(+browsers) · vitest · jest · pytest`,
  },
  // Analysis roles — share the lightweight base machine.
  architect: { image: BASE_IMAGE, memory: '1g', cpus: '1', toolingLabel: BASE_TOOLING },
  project_manager: { image: BASE_IMAGE, memory: '1g', cpus: '1', toolingLabel: BASE_TOOLING },
  reviewer: { image: BASE_IMAGE, memory: '1g', cpus: '1', toolingLabel: BASE_TOOLING },
  deployment: { image: BASE_IMAGE, memory: '1g', cpus: '1', toolingLabel: BASE_TOOLING },
  human: { image: BASE_IMAGE, memory: '1g', cpus: '1', toolingLabel: BASE_TOOLING },
};

/** Machine spec for a role (falls back to base for unknown roles). */
export function machineSpecForRole(role: string): AgentMachineSpec {
  return SPECS[role as AgentRole] ?? { image: BASE_IMAGE, memory: '1g', cpus: '1', toolingLabel: BASE_TOOLING };
}

/** Ordered list of image candidates for a role: role image → base → legacy. */
export function imageCandidates(role: string): string[] {
  const spec = machineSpecForRole(role);
  return [...new Set([spec.image, BASE_IMAGE, LEGACY_IMAGE])];
}
