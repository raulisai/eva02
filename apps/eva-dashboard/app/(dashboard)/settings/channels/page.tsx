import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { Topbar } from '@/components/layout/topbar';
import { ChannelsClient } from '@/components/settings/channels-client';
import type { Integration } from '@/lib/types';

export const metadata: Metadata = { title: 'Channels' };
export const dynamic = 'force-dynamic';

export default async function ChannelsPage() {
  const supabase = createClient();
  const { data: integrations } = await supabase
    .from('org_integrations')
    .select('id,kind,provider,label,status,config,secret_hint,updated_at')
    .eq('kind', 'channel');

  return (
    <>
      <Topbar title="Channels" subtitle="communication gateways · tokens stored encrypted" />
      <div className="flex-1 min-h-0">
        <ChannelsClient initialIntegrations={(integrations ?? []) as Integration[]} />
      </div>
    </>
  );
}
