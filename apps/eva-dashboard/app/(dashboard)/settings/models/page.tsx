import type { Metadata } from 'next';
import { requireOrgContext } from '@/lib/supabase/org';
import { Topbar } from '@/components/layout/topbar';
import { ModelsClient } from '@/components/settings/models-client';
import type { Integration } from '@/lib/types';

export const metadata: Metadata = { title: 'Models' };
export const dynamic = 'force-dynamic';

export default async function ModelsPage() {
  const { supabase, orgId } = await requireOrgContext();
  const { data: integrations } = await supabase
    .from('org_integrations')
    .select('id,kind,provider,label,status,config,secret_hint,updated_at')
    .eq('org_id', orgId)
    .eq('kind', 'model');

  return (
    <>
      <Topbar title="Models" subtitle="LLM provider API keys · encrypted at rest" />
      <div className="flex-1 min-h-0">
        <ModelsClient initialIntegrations={(integrations ?? []) as Integration[]} />
      </div>
    </>
  );
}
