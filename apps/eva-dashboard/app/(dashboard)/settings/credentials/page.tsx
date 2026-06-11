import type { Metadata } from 'next';
import { requireOrgContext } from '@/lib/supabase/org';
import { Topbar } from '@/components/layout/topbar';
import { CredentialsClient } from '@/components/settings/credentials-client';
import type { Integration } from '@/lib/types';

export const metadata: Metadata = { title: 'Credentials' };
export const dynamic = 'force-dynamic';

export default async function CredentialsPage() {
  const { supabase, orgId } = await requireOrgContext();
  const { data: integrations } = await supabase
    .from('org_integrations')
    .select('id,kind,provider,label,status,config,secret_hint,updated_at')
    .eq('org_id', orgId)
    .eq('kind', 'credential');

  return (
    <>
      <Topbar title="Credentials" subtitle="account access for the agent · encrypted, never shown again" />
      <div className="flex-1 min-h-0">
        <CredentialsClient initialIntegrations={(integrations ?? []) as Integration[]} />
      </div>
    </>
  );
}
