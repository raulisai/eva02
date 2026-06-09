-- 012_nodes_devices.sql
-- Node registry, device registry, cost tracking, and experience log.

CREATE TABLE IF NOT EXISTS nodes (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  node_key       TEXT NOT NULL,
  type           TEXT NOT NULL,
  os             TEXT,
  status         TEXT,
  battery        TEXT,
  cpu            TEXT,
  memory         TEXT,
  last_heartbeat TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, node_key)
);

CREATE TABLE IF NOT EXISTS node_capabilities (
  node_id    UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  PRIMARY KEY (node_id, capability)
);

CREATE TABLE IF NOT EXISTS devices (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  label      TEXT,
  status     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS costs (
  id         BIGSERIAL PRIMARY KEY,
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope      TEXT,
  ref_id     UUID,
  amount_usd NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experiences (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  objective        TEXT,
  plan             JSONB,
  tools_used       TEXT[],
  node_id          UUID REFERENCES nodes(id) ON DELETE SET NULL,
  model            TEXT,
  duration_ms      INT,
  cost_usd         NUMERIC,
  errors           JSONB,
  result           TEXT,
  user_feedback    TEXT,
  skill_opportunity BOOLEAN,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nodes_org_id        ON nodes(org_id);
CREATE INDEX IF NOT EXISTS idx_nodes_org_key       ON nodes(org_id, node_key);
CREATE INDEX IF NOT EXISTS idx_devices_org_id      ON devices(org_id);
CREATE INDEX IF NOT EXISTS idx_costs_org_id        ON costs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiences_org_id  ON experiences(org_id, created_at DESC);
