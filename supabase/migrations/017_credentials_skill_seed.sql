-- 017_credentials_skill_seed.sql
-- 1. org_integrations accepts kind='credential' (Google, Uber… account access).
-- 2. Seeds the built-in skill catalog (navigate, search, memory, comms, images,
--    code) for every existing organization so the dashboard reflects what EVA
--    can actually do out of the box.

-- ── allow credential integrations ──────────────────────────
ALTER TABLE org_integrations DROP CONSTRAINT IF EXISTS org_integrations_kind_check;
ALTER TABLE org_integrations
  ADD CONSTRAINT org_integrations_kind_check
  CHECK (kind IN ('model', 'channel', 'credential'));

-- ── seed built-in skills ───────────────────────────────────
WITH skill_seed(slug, display_name, description) AS (
  VALUES
    ('web-navigator',  'Navegar en internet', 'Drives the Playwright browser agent: open URLs, click, type, extract text/tables, screenshots. Sensitive clicks go through the Approval Engine.'),
    ('web-search',     'Búsqueda web',        'Search the web for current information and summarize results.'),
    ('memory-keeper',  'Memoria',             'Save and recall facts with semantic search (pgvector).'),
    ('communicator',   'Comunicación',        'Send messages and notifications through Telegram, dashboard and the wearOS watch.'),
    ('image-agent',    'Imágenes',            'Fetch or generate images and push them to channels (watch, Telegram).'),
    ('task-manager',   'Gestión de tareas',   'Create tasks, track pipeline state and report progress.'),
    ('code-runner',    'Ejecutar código',     'Run code in a sandboxed environment (always requires approval).')
)
INSERT INTO skills (org_id, slug, display_name, description, status, latest_version)
SELECT o.id, s.slug, s.display_name, s.description, 'active', '1.0.0'
FROM organizations o
CROSS JOIN skill_seed s
ON CONFLICT (org_id, slug) DO NOTHING;

INSERT INTO skill_versions (org_id, skill_id, version, manifest, instructions, checksum)
SELECT sk.org_id, sk.id, '1.0.0',
       jsonb_build_object('name', sk.slug, 'version', '1.0.0', 'builtin', true),
       'Built-in skill seeded by migration 017.',
       md5(sk.slug)
FROM skills sk
WHERE sk.latest_version = '1.0.0'
ON CONFLICT (org_id, skill_id, version) DO NOTHING;

WITH tool_seed(slug, name, capability, description, approval_level) AS (
  VALUES
    ('web-navigator', 'browser.open',          'web',          'Open a URL in a managed Playwright session', 1),
    ('web-navigator', 'browser.click',         'web',          'Click an element (prepared action + approval if sensitive)', 2),
    ('web-navigator', 'browser.extract_text',  'extract',      'Extract readable text from the current page', 0),
    ('web-navigator', 'browser.screenshot',    'web',          'Capture a screenshot of the session', 0),
    ('web-search',    'web.search',            'search',       'Search the web', 0),
    ('memory-keeper', 'memory.save',           'memory',       'Persist a memory with embeddings', 0),
    ('memory-keeper', 'memory.recall',         'recall',       'Semantic recall over memories', 0),
    ('communicator',  'telegram.send',         'integration',  'Send a Telegram message', 1),
    ('communicator',  'wear.notify',           'integration',  'Push a notification card to the watch', 0),
    ('communicator',  'wear.open_app',         'integration',  'Open an app on the watch by package name', 1),
    ('image-agent',   'image.fetch',           'web',          'Fetch an image from the web', 0),
    ('image-agent',   'image.generate',        'generate',     'Generate an image with a model', 1),
    ('task-manager',  'task.create',           'generate',     'Create a task in the pipeline', 0),
    ('task-manager',  'task.status',           'query',        'Report pipeline state of a task', 0),
    ('code-runner',   'code.execute',          'execute',      'Run code in the sandbox', 2)
)
INSERT INTO tools (org_id, skill_id, skill_version_id, name, capability, description, approval_level)
SELECT sv.org_id, sv.skill_id, sv.id, ts.name, ts.capability, ts.description, ts.approval_level
FROM skill_versions sv
JOIN skills sk ON sk.id = sv.skill_id
JOIN tool_seed ts ON ts.slug = sk.slug
WHERE sv.version = '1.0.0'
ON CONFLICT (org_id, skill_version_id, name) DO NOTHING;
