-- Migration 030: capability_gaps
-- Registers every time the agent had to descend to L3+ (collaboration / manual guide / retry)
-- because a capability was missing. Feeds the gap digest heartbeat and self-improvement batch.

create table if not exists capability_gaps (
  id         uuid        primary key default gen_random_uuid(),
  org_id     uuid        not null references organizations(id) on delete cascade,
  capability text        not null,
  goal       text,
  -- L3 = collaboration, L4 = manual guide, L5 = deferred retry
  ladder_level smallint  not null default 3 check (ladder_level between 3 and 5),
  -- {"integration": "whatsapp", "kind": "integration"} or {"tool": "docker"} etc.
  missing    jsonb,
  task_id    uuid        references tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists capability_gaps_org_created
  on capability_gaps(org_id, created_at desc);

create index if not exists capability_gaps_org_capability
  on capability_gaps(org_id, capability, resolved_at);

-- RLS — every row is scoped to the user's org (same pattern as all other tables)
alter table capability_gaps enable row level security;

-- Users can only read/write gaps in their own org
create policy "org members can manage capability_gaps"
  on capability_gaps
  for all
  using (org_id = any(
    select org_id from users where id = auth.uid()
  ));
