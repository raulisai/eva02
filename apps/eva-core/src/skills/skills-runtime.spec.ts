import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SKILLS_ROOT = __dirname;

function walkSkillFiles(dir = SKILLS_ROOT): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isDirectory()) return walkSkillFiles(fullPath);
      return entry === 'SKILL.md' ? [fullPath] : [];
    })
    .sort();
}

function walkRuntimeFiles(dir = SKILLS_ROOT): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isDirectory()) return walkRuntimeFiles(fullPath);
      return fullPath.endsWith('.spec.ts') ? [] : [fullPath];
    })
    .sort();
}

function frontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  return Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1], match[2].trim().replace(/^["']|["']$/g, '')]),
  );
}

describe('runtime skills curation', () => {
  const skillFiles = walkSkillFiles();

  it('keeps a curated runtime skill set', () => {
    expect(skillFiles.map((file) => relative(SKILLS_ROOT, file))).toEqual([
      'build-skill/SKILL.md',
      'creative/architecture-diagram/SKILL.md',
      'dogfood/SKILL.md',
      'github/codebase-inspection/SKILL.md',
      'github/github-code-review/SKILL.md',
      'media/youtube-content/SKILL.md',
      'productivity/maps/SKILL.md',
      'productivity/ocr-and-documents/SKILL.md',
      'research/arxiv/SKILL.md',
      'software-development/plan/SKILL.md',
      'software-development/requesting-code-review/SKILL.md',
      'software-development/spike/SKILL.md',
      'software-development/systematic-debugging/SKILL.md',
      'software-development/test-driven-development/SKILL.md',
    ]);
  });

  it('has valid metadata and visible EVA safety guidance', () => {
    for (const file of skillFiles) {
      const markdown = readFileSync(file, 'utf8');
      const metadata = frontmatter(markdown);

      expect(metadata.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(metadata.description).toBeTruthy();
      expect(metadata.description.length).toBeLessThanOrEqual(180);
      expect(markdown).toContain('## EVA Runtime Safety');
      expect(markdown).toContain('RUNTIME_SKILL_POLICY.md');
    }
  });

  it('does not retain high-risk external action skills', () => {
    for (const removedPath of [
      'apple',
      'autonomous-ai-agents',
      'email',
      'mlops',
      'social-media',
      'smart-home',
      'research/polymarket',
      'productivity/airtable',
      'productivity/google-workspace',
      'productivity/notion',
      'index-cache',
    ]) {
      expect(existsSync(join(SKILLS_ROOT, removedPath))).toBe(false);
    }
  });

  it('does not include unadapted external-agent instructions or credential scraping', () => {
    const banned = [
      /Agent Zero/i,
      /Hermes/i,
      /\.hermes/i,
      /HERMES_HOME/,
      /GITHUB_TOKEN/,
      /delegate_task/,
      /skill_view/,
      /write_file/,
      /curl\s+.*\|\s*(?:bash|sh|tar)/i,
      /ignore (?:all )?(?:previous|prior) instructions/i,
    ];

    for (const file of walkRuntimeFiles()) {
      const markdown = readFileSync(file, 'utf8');
      for (const pattern of banned) {
        expect(markdown).not.toMatch(pattern);
      }
    }
  });

  it('approval-gates dependency installation guidance', () => {
    for (const file of skillFiles) {
      const markdown = readFileSync(file, 'utf8');
      if (/\bpip install\s+\S|\bnpm install\s+\S|\bnpx\s+\S|\bbrew install\s+\S/.test(markdown)) {
        expect(markdown).toMatch(/install(?:s|ing|ation)? require[s]? approval|requires approval/i);
      }
    }
  });
});
