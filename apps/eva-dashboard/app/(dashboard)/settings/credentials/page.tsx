import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { Topbar } from '@/components/layout/topbar';
import { CredentialsClient } from '@/components/settings/credentials-client';
import type { Integration } from '@/lib/types';

export const metadata: Metadata = { title: 'Credentials' };
export const dynamic = 'force-dynamic';

export default async function CredentialsPage() {
  const supabase = createClient();
  const { data: integrations } = await supabase
    .from('org_integrations')
    .select('id,kind,provider,label,status,config,secret_hint,updated_at')
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
