import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ToolDefinition,
  RouteDecision,
  RouteOptions,
  DEFAULT_TOOLS,
} from './tool-router.types';

const COST_WEIGHT    = 0.5;
const LATENCY_WEIGHT = 0.3;
const TOKEN_WEIGHT   = 0.2;

const BUDGET_COST_CEILING: Record<string, number> = {
  cheap:     4,
  balanced:  10,
  powerful:  Infinity,
};

@Injectable()
export class ToolRouterService {
  private readonly logger = new Logger(ToolRouterService.name);
  private readonly registry = new Map<string, ToolDefinition>();

  constructor() {
    DEFAULT_TOOLS.forEach(t => this.registry.set(t.name, t));
  }

  // ── Public API ────────────────────────────────────────────────────────────

  route(capability: string, opts: RouteOptions = {}): RouteDecision {
    const candidates = this.findCandidates(capability, opts);

    if (candidates.length === 0) {
      throw new NotFoundException(
        `No available tool found for capability "${capability}"` +
        (opts.budget ? ` within budget "${opts.budget}"` : ''),
      );
    }

    // Score: lower is better. Normalised against registry max values.
    const maxCost    = Math.max(...[...this.registry.values()].map(t => t.costPerToken), 1);
    const maxLatency = Math.max(...[...this.registry.values()].map(t => t.avgLatencyMs), 1);
    const maxTokens  = Math.max(...[...this.registry.values()].map(t => t.maxTokens), 1);

    const scored = candidates.map(tool => ({
      tool,
      score: this.score(tool, maxCost, maxLatency, maxTokens),
    }));

    scored.sort((a, b) => a.score - b.score);

    const [best, ...rest] = scored;

    this.logger.debug(
      `Routed capability="${capability}" → ${best.tool.name} (score=${best.score.toFixed(3)})`,
    );

    return {
      tool:               best.tool,
      matchedCapability:  capability,
      alternates:         rest.map(s => s.tool),
      score:              best.score,
    };
  }

  routeAll(capabilities: string[], opts: RouteOptions = {}): Record<string, RouteDecision> {
    return Object.fromEntries(
      capabilities.map(cap => [cap, this.route(cap, opts)]),
    );
  }

  listAll(): ToolDefinition[] {
    return [...this.registry.values()];
  }

  register(tool: ToolDefinition): void {
    this.registry.set(tool.name, tool);
    this.logger.log(`Registered tool: ${tool.name}`);
  }

  setAvailable(name: string, available: boolean): void {
    const tool = this.registry.get(name);
    if (tool) {
      tool.available = available;
      this.logger.log(`Tool ${name} availability → ${available}`);
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private findCandidates(capability: string, opts: RouteOptions): ToolDefinition[] {
    const costCeiling  = BUDGET_COST_CEILING[opts.budget ?? 'powerful'] ?? Infinity;
    const latencyCap   = opts.maxLatencyMs ?? Infinity;
    const excluded     = new Set(opts.excludeTools ?? []);
    const capLower     = capability.toLowerCase();

    return [...this.registry.values()].filter(
      t =>
        t.available &&
        !excluded.has(t.name) &&
        t.costPerToken <= costCeiling &&
        (t.avgLatencyMs <= latencyCap || t.avgLatencyMs === 0) &&
        t.capabilities.some(c => c.toLowerCase() === capLower),
    );
  }

  private score(
    tool: ToolDefinition,
    maxCost: number,
    maxLatency: number,
    maxTokens: number,
  ): number {
    const costNorm    = maxCost    > 0 ? tool.costPerToken / maxCost        : 0;
    const latNorm     = maxLatency > 0 ? tool.avgLatencyMs / maxLatency      : 0;
    const tokenNorm   = maxTokens  > 0 ? 1 - tool.maxTokens / maxTokens     : 0; // more tokens → better → lower penalty
    return COST_WEIGHT * costNorm + LATENCY_WEIGHT * latNorm + TOKEN_WEIGHT * tokenNorm;
  }
}
