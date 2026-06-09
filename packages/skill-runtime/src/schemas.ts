import { z } from 'zod';

export const SkillManifestSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  display_name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  author: z.string().min(1).default('eva'),
  capabilities: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
});

export const SkillToolSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_.-]+$/),
  capability: z.string().min(1),
  description: z.string().min(1),
  input_schema: z.record(z.string(), z.unknown()).default({}),
  approval_level: z.number().int().min(0).max(3).default(0),
});

export const SkillToolsSchema = z.object({
  tools: z.array(SkillToolSchema).default([]),
});

export const SkillPermissionsSchema = z.object({
  scopes: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  network: z.array(z.string()).default([]),
  secrets: z.array(z.string()).default([]),
  filesystem: z.array(z.string()).default([]),
});

export const SkillExampleSchema = z.object({
  name: z.string().min(1),
  input: z.string().min(1),
  expected_tool: z.string().optional(),
});

export const SkillExamplesSchema = z.object({
  examples: z.array(SkillExampleSchema).default([]),
});

export const SkillTestsSchema = z.object({
  tests: z.array(z.object({
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
    expect: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
});

export const MemoryPolicySchema = z.object({
  read: z.boolean().default(false),
  write: z.boolean().default(false),
  retention: z.enum(['none', 'session', 'long_term']).default('none'),
  allowed_types: z.array(z.string()).default([]),
});

export const ApprovalPolicySchema = z.object({
  default_level: z.number().int().min(0).max(3).default(0),
  rules: z.array(z.object({
    match: z.string().min(1),
    level: z.number().int().min(0).max(3),
    reason: z.string().optional(),
  })).default([]),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type SkillTool = z.infer<typeof SkillToolSchema>;
export type SkillPermissions = z.infer<typeof SkillPermissionsSchema>;
export type SkillApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type SkillMemoryPolicy = z.infer<typeof MemoryPolicySchema>;
