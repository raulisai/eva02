-- 021_schedule_places_patterns.sql
-- Local schedule, known places and behavior patterns.
-- These tables are the primary source of truth for EVA's knowledge of the user's
-- routine. Google Calendar (when configured) is an optional enrichment source.

-- ── schedule_events ───────────────────────────────────────────────────────────
-- Events created by the watch, the user through voice/text, or synced from
-- external calendars. 'source' tracks the origin.
CREATE TABLE IF NOT EXISTS schedule_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  description    TEXT,
  event_type     TEXT NOT NULL DEFAULT 'one_time'
                   CHECK (event_type IN ('one_time', 'recurring')),
  -- one_time
  scheduled_date DATE,
  scheduled_time TIME,
  -- recurring: {days: ["mon","tue"], time: "09:00", until?: "2026-12-31"}
  recurrence     JSONB,
  duration_min   INT DEFAULT 60,
  location_label TEXT,   -- human-readable: "oficina", "gym", "casa"
  location_type  TEXT CHECK (location_type IN ('home','work','gym','restaurant','transit','other')),
  source         TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','wear','voice','google_calendar','pattern')),
  external_id    TEXT,   -- Google Calendar event id, etc.
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_schedule_events_org_date
  ON schedule_events(org_id, scheduled_date) WHERE event_type = 'one_time';
CREATE INDEX IF NOT EXISTS idx_schedule_events_org_recurring
  ON schedule_events(org_id) WHERE event_type = 'recurring';

DROP TRIGGER IF EXISTS schedule_events_updated_at ON schedule_events;
CREATE TRIGGER schedule_events_updated_at
  BEFORE UPDATE ON schedule_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── known_places ──────────────────────────────────────────────────────────────
-- Detected automatically from GPS visits (watch sensors.share location)
-- or added manually. EVA uses these to understand commute patterns and
-- suggest context-aware actions (Uber, food orders, etc.).
CREATE TABLE IF NOT EXISTS known_places (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,   -- 'home', 'work', 'gym', 'cafe_favorito'
  address      TEXT,
  lat          REAL,
  lng          REAL,
  radius_m     INT NOT NULL DEFAULT 150,   -- geofence radius for "is user here"
  visit_count  INT NOT NULL DEFAULT 0,
  last_visit   TIMESTAMPTZ,
  typical_days TEXT[],   -- ['mon','tue','wed','thu','fri']
  typical_time TIME,     -- average arrival time
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, label)
);

CREATE INDEX IF NOT EXISTS idx_known_places_org ON known_places(org_id);

-- ── location_visits ───────────────────────────────────────────────────────────
-- Raw location readings from the watch. Used by the pattern engine.
-- Kept for 90 days, then can be pruned.
CREATE TABLE IF NOT EXISTS location_visits (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  accuracy_m    REAL,
  place_id      UUID REFERENCES known_places(id) ON DELETE SET NULL,
  place_label   TEXT,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_location_visits_org_time
  ON location_visits(org_id, recorded_at DESC);

-- ── behavior_patterns ─────────────────────────────────────────────────────────
-- Detected behavioral patterns that EVA can use to make proactive suggestions.
-- Examples: "commute to work Mon-Fri ~8:45", "orders food on Fridays ~13:00"
CREATE TABLE IF NOT EXISTS behavior_patterns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pattern_type     TEXT NOT NULL
                     CHECK (pattern_type IN ('commute','food','gym','routine','uber','shopping','other')),
  title            TEXT NOT NULL,
  description      TEXT,
  trigger_days     TEXT[],   -- ['mon','tue','wed','thu','fri']
  trigger_time     TIME,     -- approx trigger time (±30 min window)
  trigger_place_id UUID REFERENCES known_places(id) ON DELETE SET NULL,
  -- What EVA should suggest when this pattern triggers
  suggested_action JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {type: 'uber', destination: 'work', message: '¿Llamo el Uber al trabajo?'}
  -- {type: 'food', restaurant: 'La Poblanita', message: '¿Pido tu almuerzo de siempre?'}
  confidence       REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  confirmed        BOOLEAN NOT NULL DEFAULT false,   -- user explicitly confirmed
  active           BOOLEAN NOT NULL DEFAULT true,
  last_triggered   TIMESTAMPTZ,
  sample_count     INT NOT NULL DEFAULT 1,   -- how many observations support this
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_behavior_patterns_org_active
  ON behavior_patterns(org_id, active, trigger_time)
  WHERE active = true;

DROP TRIGGER IF EXISTS behavior_patterns_updated_at ON behavior_patterns;
CREATE TRIGGER behavior_patterns_updated_at
  BEFORE UPDATE ON behavior_patterns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE schedule_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE known_places       ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_visits    ENABLE ROW LEVEL SECURITY;
ALTER TABLE behavior_patterns  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "schedule_events_org"   ON schedule_events
  FOR ALL USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "known_places_org"      ON known_places
  FOR ALL USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "location_visits_org"   ON location_visits
  FOR ALL USING (org_id = ANY(public.user_org_ids()));
CREATE POLICY "behavior_patterns_org" ON behavior_patterns
  FOR ALL USING (org_id = ANY(public.user_org_ids()));

-- ── Grants ────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_events   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON known_places      TO authenticated;
GRANT SELECT, INSERT               ON location_visits    TO authenticated;
GRANT SELECT, INSERT, UPDATE       ON behavior_patterns  TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE location_visits_id_seq TO authenticated;
