-- Organizations (tenants)
CREATE TABLE IF NOT EXISTS organizations (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           TEXT NOT NULL,
  plan           TEXT NOT NULL DEFAULT 'free',
  cost_limit_usd NUMERIC DEFAULT 50,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Users: links auth.users to an organization
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  display_name TEXT,
  role         TEXT NOT NULL DEFAULT 'member'
                 CHECK (role IN ('owner', 'admin', 'member')),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);
