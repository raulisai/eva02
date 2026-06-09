import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApprovalPolicySchema,
  MemoryPolicySchema,
  SkillApprovalPolicy,
  SkillExamplesSchema,
  SkillManifest,
  SkillManifestSchema,
  SkillPermissions,
  SkillPermissionsSchema,
  SkillTestsSchema,
  SkillTool,
  SkillToolsSchema,
} from './schemas';

export interface LoadedSkill {
  dir: string;
  manifest: SkillManifest;
  instructions: string;
  tools: SkillTool[];
  permissions: SkillPermissions;
  examples: unknown[];
  tests: unknown[];
  memory_policy: unknown;
  approval_policy: SkillApprovalPolicy;
  checksum: string;
}

export interface SkillVersionRecord {
  skill: LoadedSkill;
  version: string;
  checksum: string;
  created_at: string;
}

const REQUIRED_FILES = [
  'manifest.json',
  'instructions.md',
  'tools.json',
  'permissions.json',
  'examples.json',
  'tests.json',
  'memory_policy.json',
  'approval_policy.json',
];

export class SkillLoader {
  async loadSkill(dir: string): Promise<LoadedSkill> {
    const files = Object.fromEntries(
      await Promise.all(REQUIRED_FILES.map(async (file) => [file, await readFile(join(dir, file), 'utf8')])),
    ) as Record<string, string>;

    const manifest = SkillManifestSchema.parse(JSON.parse(files['manifest.json']));
    const tools = SkillToolsSchema.parse(JSON.parse(files['tools.json'])).tools;
    const permissions = SkillPermissionsSchema.parse(JSON.parse(files['permissions.json']));
    const examples = SkillExamplesSchema.parse(JSON.parse(files['examples.json'])).examples;
    const tests = SkillTestsSchema.parse(JSON.parse(files['tests.json'])).tests;
    const memoryPolicy = MemoryPolicySchema.parse(JSON.parse(files['memory_policy.json']));
    const approvalPolicy = ApprovalPolicySchema.parse(JSON.parse(files['approval_policy.json']));
    const checksum = checksumSkill(files);

    return {
      dir,
      manifest,
      instructions: files['instructions.md'],
      tools,
      permissions,
      examples,
      tests,
      memory_policy: memoryPolicy,
      approval_policy: approvalPolicy,
      checksum,
    };
  }
}

export class SkillRegistry {
  private readonly versions = new Map<string, SkillVersionRecord[]>();

  register(skill: LoadedSkill): SkillVersionRecord {
    const key = skill.manifest.name;
    const existing = this.versions.get(key) ?? [];
    if (existing.some((record) => record.version === skill.manifest.version)) {
      throw new Error(`Skill ${key}@${skill.manifest.version} is already registered`);
    }

    const record = {
      skill,
      version: skill.manifest.version,
      checksum: skill.checksum,
      created_at: new Date().toISOString(),
    };
    this.versions.set(key, [...existing, record]);
    return record;
  }

  latest(skillName: string): SkillVersionRecord | null {
    const records = this.versions.get(skillName) ?? [];
    return records[records.length - 1] ?? null;
  }

  versionsFor(skillName: string): SkillVersionRecord[] {
    return [...(this.versions.get(skillName) ?? [])];
  }
}

export class SkillPermissionEvaluator {
  canUseTool(skill: LoadedSkill, toolName: string): boolean {
    const tool = skill.tools.find((candidate) => candidate.name === toolName);
    if (!tool) return false;
    return skill.permissions.tools.includes(toolName) || skill.permissions.tools.includes('*');
  }

  approvalLevelFor(skill: LoadedSkill, toolName: string, input: Record<string, unknown> = {}): number {
    const tool = skill.tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Tool ${toolName} is not declared by ${skill.manifest.name}`);
    const haystack = `${toolName} ${JSON.stringify(input)}`;
    const rule = skill.approval_policy.rules.find((candidate) => new RegExp(candidate.match, 'i').test(haystack));
    return rule?.level ?? Math.max(tool.approval_level, skill.approval_policy.default_level);
  }
}

export function checksumSkill(files: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) {
    hash.update(name);
    hash.update('\n');
    hash.update(files[name]);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export * from './schemas';
