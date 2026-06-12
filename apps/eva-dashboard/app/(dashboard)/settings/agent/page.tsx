import type { Metadata } from 'next';
import { requireOrgContext } from '@/lib/supabase/org';
import { Topbar } from '@/components/layout/topbar';
import { AgentClient } from '@/components/settings/agent-client';

export const metadata: Metadata = { title: 'Agent Settings & Autonomy' };
export const dynamic = 'force-dynamic';

export default async function AgentSettingsPage() {
  const { supabase, orgId } = await requireOrgContext();

  const [settingsRes, efficiencyRes, defenseRes, toolsRes] = await Promise.all([
    supabase.from('org_agent_settings').select('*').eq('org_id', orgId).maybeSingle(),
    supabase.from('agent_task_efficiency_metrics').select('*').eq('org_id', orgId).maybeSingle(),
    supabase.from('agent_defense_metrics').select('*').eq('org_id', orgId).maybeSingle(),
    supabase.from('agent_tool_success_metrics').select('*').eq('org_id', orgId),
  ]);

  return (
    <>
      <Topbar title="Agent Settings & Autonomy" subtitle="Manage autonomous boundaries, token limits and monitor agent telemetry" />
      <div className="flex-1 min-h-0">
        <AgentClient
          orgId={orgId}
          initialSettings={settingsRes.data || null}
          efficiency={efficiencyRes.data || null}
          defense={defenseRes.data || null}
          toolMetrics={toolsRes.data || []}
        />
      </div>
    </>
  );
}
