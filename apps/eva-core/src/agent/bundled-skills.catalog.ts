export type SkillSource = 'bundled' | 'generated';

export interface BundledSkillCatalogEntry {
  slug: string;
  displayName: string;
  category: 'development' | 'review' | 'research' | 'productivity' | 'qa' | 'creative';
  description: string;
  triggers: string[];
  negativeTriggers?: string[];
  agentRole: string;
  baseWeight: number;
  maxConcurrency: number;
  graph: Array<{
    to: string;
    relation: 'supports' | 'precedes' | 'validates' | 'fallback';
    weight: number;
  }>;
}

export const BUNDLED_SKILL_CATALOG: BundledSkillCatalogEntry[] = [
  {
    slug: 'plan',
    displayName: 'Plan',
    category: 'development',
    description: 'Plan implementation work before code changes, including EVA org_id, RLS, Approval Engine, files, risks, and verification.',
    triggers: ['plan', 'planning', 'arquitectura', 'diseña', 'roadmap', 'pasos', 'enfoque', 'antes de implementar'],
    agentRole: 'planner',
    baseWeight: 1.4,
    maxConcurrency: 2,
    graph: [
      { to: 'test-driven-development', relation: 'precedes', weight: 0.7 },
      { to: 'requesting-code-review', relation: 'precedes', weight: 0.5 },
      { to: 'architecture-diagram', relation: 'supports', weight: 0.35 },
    ],
  },
  {
    slug: 'test-driven-development',
    displayName: 'Test-Driven Development',
    category: 'development',
    description: 'Use red-green-refactor for EVA features, bug fixes, refactors, tenant isolation, approvals, and task state changes.',
    triggers: ['test', 'tdd', 'bug fix', 'feature', 'refactor', 'estado', 'approval', 'rls', 'org_id', 'regresion'],
    negativeTriggers: ['solo plan', 'solo revisar'],
    agentRole: 'test-driven engineer',
    baseWeight: 1.35,
    maxConcurrency: 3,
    graph: [
      { to: 'systematic-debugging', relation: 'supports', weight: 0.5 },
      { to: 'requesting-code-review', relation: 'validates', weight: 0.75 },
    ],
  },
  {
    slug: 'systematic-debugging',
    displayName: 'Systematic Debugging',
    category: 'development',
    description: 'Reproduce failures, find root cause, fix narrowly, and prove the fix with focused tests.',
    triggers: ['debug', 'error', 'falla', 'failed', 'timeout', 'no funciona', 'regresion', 'bug', 'stack trace'],
    agentRole: 'debugger',
    baseWeight: 1.45,
    maxConcurrency: 2,
    graph: [
      { to: 'test-driven-development', relation: 'validates', weight: 0.65 },
      { to: 'codebase-inspection', relation: 'supports', weight: 0.25 },
    ],
  },
  {
    slug: 'requesting-code-review',
    displayName: 'Requesting Code Review',
    category: 'review',
    description: 'Pre-commit quality and security review for EVA changes before delivery, commit, push, or merge.',
    triggers: ['review', 'verifica', 'antes de commit', 'ship', 'done', 'calidad', 'security scan', 'lint', 'tests'],
    agentRole: 'quality reviewer',
    baseWeight: 1.2,
    maxConcurrency: 2,
    graph: [
      { to: 'github-code-review', relation: 'supports', weight: 0.45 },
      { to: 'test-driven-development', relation: 'validates', weight: 0.55 },
    ],
  },
  {
    slug: 'github-code-review',
    displayName: 'GitHub Code Review',
    category: 'review',
    description: 'Review local git diffs or PR diffs for bugs, tenant isolation regressions, missing tests, and unsafe changes.',
    triggers: ['pr', 'pull request', 'diff', 'git', 'code review', 'cambios', 'merge'],
    negativeTriggers: ['crear issue', 'publicar', 'mergear'],
    agentRole: 'code reviewer',
    baseWeight: 1.05,
    maxConcurrency: 2,
    graph: [
      { to: 'requesting-code-review', relation: 'supports', weight: 0.5 },
      { to: 'codebase-inspection', relation: 'supports', weight: 0.25 },
    ],
  },
  {
    slug: 'spike',
    displayName: 'Spike',
    category: 'development',
    description: 'Design a small disposable experiment to validate risky implementation ideas before production work.',
    triggers: ['spike', 'prototipo', 'experimento', 'validar idea', 'posible', 'comparar enfoques', 'riesgo'],
    negativeTriggers: ['produccion', 'deploy'],
    agentRole: 'prototype engineer',
    baseWeight: 1,
    maxConcurrency: 2,
    graph: [
      { to: 'plan', relation: 'precedes', weight: 0.4 },
      { to: 'test-driven-development', relation: 'precedes', weight: 0.35 },
    ],
  },
  {
    slug: 'build-skill',
    displayName: 'Build Skill',
    category: 'development',
    description: 'Build, audit, rename, or refactor EVA runtime skills with safe metadata and scoped instructions.',
    triggers: ['skill', 'skills', 'catalogo', 'runtime skill', 'crear skill', 'auditar skill', 'renombrar skill'],
    agentRole: 'skill curator',
    baseWeight: 1.25,
    maxConcurrency: 1,
    graph: [
      { to: 'requesting-code-review', relation: 'validates', weight: 0.4 },
    ],
  },
  {
    slug: 'dogfood',
    displayName: 'Dogfood QA',
    category: 'qa',
    description: 'Exploratory QA of web apps with evidence, console checks, accessibility observations, and structured bug reports.',
    triggers: ['qa', 'dogfood', 'exploratory', 'navega', 'web app', 'browser', 'e2e manual', 'bug report'],
    negativeTriggers: ['enviar mensaje', 'comprar'],
    agentRole: 'qa tester',
    baseWeight: 1,
    maxConcurrency: 2,
    graph: [
      { to: 'github-code-review', relation: 'supports', weight: 0.25 },
      { to: 'requesting-code-review', relation: 'validates', weight: 0.35 },
    ],
  },
  {
    slug: 'codebase-inspection',
    displayName: 'Codebase Inspection',
    category: 'review',
    description: 'Inspect repository size, language mix, file counts, hotspots, and rough code/comment ratios.',
    triggers: ['loc', 'lineas de codigo', 'tamaño repo', 'lenguajes', 'codebase', 'inspecciona repo', 'metricas'],
    agentRole: 'codebase analyst',
    baseWeight: 0.8,
    maxConcurrency: 2,
    graph: [
      { to: 'github-code-review', relation: 'supports', weight: 0.25 },
    ],
  },
  {
    slug: 'arxiv',
    displayName: 'arXiv Research',
    category: 'research',
    description: 'Search public arXiv papers by keyword, author, category, or ID and summarize relevant research.',
    triggers: ['arxiv', 'paper', 'papers', 'research', 'investigacion', 'literature', 'modelo', 'ml', 'llm'],
    agentRole: 'researcher',
    baseWeight: 0.95,
    maxConcurrency: 3,
    graph: [
      { to: 'ocr-and-documents', relation: 'supports', weight: 0.3 },
      { to: 'youtube-content', relation: 'fallback', weight: 0.15 },
    ],
  },
  {
    slug: 'youtube-content',
    displayName: 'YouTube Content',
    category: 'research',
    description: 'Extract and transform YouTube transcripts into summaries, chapters, quotes, articles, or short post drafts.',
    triggers: ['youtube', 'video', 'transcript', 'transcripcion', 'resumen video', 'capitulos', 'timestamps'],
    negativeTriggers: ['publicar'],
    agentRole: 'media researcher',
    baseWeight: 0.85,
    maxConcurrency: 2,
    graph: [
      { to: 'arxiv', relation: 'supports', weight: 0.15 },
    ],
  },
  {
    slug: 'ocr-and-documents',
    displayName: 'OCR And Documents',
    category: 'productivity',
    description: 'Extract text from PDFs, scanned documents, tables, metadata, and page ranges without exposing private data.',
    triggers: ['pdf', 'ocr', 'documento', 'scan', 'escaneado', 'extraer texto', 'tabla', 'pymupdf'],
    agentRole: 'document analyst',
    baseWeight: 0.95,
    maxConcurrency: 2,
    graph: [
      { to: 'arxiv', relation: 'supports', weight: 0.3 },
    ],
  },
  {
    slug: 'maps',
    displayName: 'Maps',
    category: 'productivity',
    description: 'Geocode places, reverse coordinates, find public POIs, routes, distances, and timezones via open map data.',
    triggers: ['mapa', 'maps', 'direccion', 'coordenadas', 'cerca', 'ruta', 'distancia', 'timezone', 'geocode'],
    agentRole: 'location analyst',
    baseWeight: 0.85,
    maxConcurrency: 2,
    graph: [],
  },
  {
    slug: 'architecture-diagram',
    displayName: 'Architecture Diagram',
    category: 'creative',
    description: 'Create local SVG/HTML architecture diagrams for EVA systems, modules, data flows, and infrastructure.',
    triggers: ['diagrama', 'arquitectura', 'infra', 'data flow', 'sistema', 'modulos', 'visualiza'],
    negativeTriggers: ['editar imagen', 'foto'],
    agentRole: 'architecture diagrammer',
    baseWeight: 0.75,
    maxConcurrency: 1,
    graph: [
      { to: 'plan', relation: 'supports', weight: 0.25 },
    ],
  },
];

export const BUNDLED_SKILL_BY_SLUG = new Map(BUNDLED_SKILL_CATALOG.map((skill) => [skill.slug, skill]));
