import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Topbar } from '@/components/layout/topbar';
import { SoulEditor } from '@/components/soul/soul-editor';
import type { AgentSoul } from '@/lib/types';

export const metadata: Metadata = { title: 'Soul' };
export const dynamic = 'force-dynamic';

export default async function SoulPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('users')
    .select('org_id')
    .eq('id', user.id)
    .single();
  if (!profile?.org_id) redirect('/login');

  const { data: soul } = await supabase
    .from('agent_souls')
    .select('*')
    .eq('org_id', profile.org_id)
    .maybeSingle();

  return (
    <>
      <Topbar title="Soul" subtitle="agent identity · directives · autonomy" />
      <div className="flex-1 min-h-0">
        <SoulEditor orgId={profile.org_id} initialSoul={soul as AgentSoul | null} />
      </div>
    </>
  );
}
