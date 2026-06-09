import { McpToolDefinition } from './types';

const DESTRUCTIVE_PATTERNS = [
  /\bdrop\s+table\b/i,
  /\bdelete\b/i,
  /\bdestroy\b/i,
  /\bterminate\b/i,
  /\bproduction\b/i,
  /\bsecret\b/i,
];

export class McpSandbox {
  assertAllowed(tool: McpToolDefinition, input: Record<string, unknown>): void {
    const serialized = JSON.stringify(input);
    if (tool.sandbox.read_only && DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(serialized))) {
      throw new Error(`Sandbox blocked destructive input for ${tool.name}`);
    }
    if (!tool.sandbox.network?.length && serialized.includes('http')) {
      throw new Error(`Sandbox blocks network egress for ${tool.name}`);
    }
  }
}
