-- ── Wear OS UI System ─────────────────────────────────────────────────────────
-- Capabilities declared by each device (what the watch can render/use)
CREATE TABLE IF NOT EXISTS wear_capabilities (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  capability  TEXT NOT NULL,
  version     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_wear_capabilities_org_id    ON wear_capabilities(org_id);
CREATE INDEX IF NOT EXISTS idx_wear_capabilities_device_id ON wear_capabilities(device_id);

-- SDUI directives pushed from Core to watch
CREATE TABLE IF NOT EXISTS wear_directives (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  delivered   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wear_directives_org_id    ON wear_directives(org_id);
CREATE INDEX IF NOT EXISTS idx_wear_directives_device_id ON wear_directives(device_id);
CREATE INDEX IF NOT EXISTS idx_wear_directives_delivered ON wear_directives(delivered) WHERE NOT delivered;

-- Form responses submitted from watch UI
CREATE TABLE IF NOT EXISTS wear_form_responses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  directive_id UUID REFERENCES wear_directives(id) ON DELETE SET NULL,
  task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,
  form_key    TEXT NOT NULL,
  response    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wear_form_responses_org_id    ON wear_form_responses(org_id);
CREATE INDEX IF NOT EXISTS idx_wear_form_responses_device_id ON wear_form_responses(device_id);

-- Sensor and app access consents granted by the user on the watch
CREATE TABLE IF NOT EXISTS wear_sensor_consents (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource    TEXT NOT NULL,   -- e.g. "heart_rate", "location", "notifications"
  granted     BOOLEAN NOT NULL DEFAULT FALSE,
  granted_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (device_id, resource)
);

CREATE INDEX IF NOT EXISTS idx_wear_sensor_consents_org_id    ON wear_sensor_consents(org_id);
CREATE INDEX IF NOT EXISTS idx_wear_sensor_consents_device_id ON wear_sensor_consents(device_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE wear_capabilities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wear_directives      ENABLE ROW LEVEL SECURITY;
ALTER TABLE wear_form_responses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wear_sensor_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wear_capabilities_select" ON wear_capabilities
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "wear_capabilities_insert" ON wear_capabilities
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));
CREATE POLICY "wear_capabilities_update" ON wear_capabilities
  FOR UPDATE USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "wear_directives_select" ON wear_directives
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "wear_directives_insert" ON wear_directives
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));
CREATE POLICY "wear_directives_update" ON wear_directives
  FOR UPDATE USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "wear_form_responses_select" ON wear_form_responses
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "wear_form_responses_insert" ON wear_form_responses
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));

CREATE POLICY "wear_sensor_consents_select" ON wear_sensor_consents
  FOR SELECT USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "wear_sensor_consents_insert" ON wear_sensor_consents
  FOR INSERT WITH CHECK (org_id = ANY(public.user_org_ids()));
CREATE POLICY "wear_sensor_consents_update" ON wear_sensor_consents
  FOR UPDATE USING (org_id = ANY(public.user_org_ids()))
  WITH CHECK (org_id = ANY(public.user_org_ids()));

-- ── Grants ────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON
  wear_capabilities, wear_directives, wear_sensor_consents
TO authenticated;

GRANT SELECT, INSERT ON wear_form_responses TO authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
