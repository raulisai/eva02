import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Topbar } from '@/components/layout/topbar';
import { ProfileHubClient } from '@/components/profile/profile-hub-client';
import { requireOrgContext } from '@/lib/supabase/org';

export const metadata: Metadata = { title: 'Mi Perfil' };
export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const { supabase, orgId } = await requireOrgContext();

  const [
    soulResult,
    todosResult,
    notesResult,
    goalsResult,
    privateResult,
    scheduleResult,
    placesResult,
  ] = await Promise.all([
    supabase
      .from('agent_souls')
      .select('persona_context')
      .eq('org_id', orgId)
      .maybeSingle(),
    supabase
      .from('profile_todos')
      .select('id,title,notes,status,due_date,priority,sensitivity,sensitive_hint,position')
      .eq('org_id', orgId)
      .order('position', { ascending: true }),
    supabase
      .from('profile_notes')
      .select('id,title,content,pinned,sensitivity,sensitive_hint,updated_at')
      .eq('org_id', orgId)
      .order('pinned', { ascending: false }),
    supabase
      .from('profile_goals')
      .select('id,title,description,status,deadline,progress,category,sensitivity,sensitive_hint,updated_at')
      .eq('org_id', orgId)
      .order('updated_at', { ascending: false }),
    supabase
      .from('profile_private_items')
      .select('id,kind,label,hint,sensitivity,updated_at')
      .eq('org_id', orgId)
      .order('updated_at', { ascending: false }),
    supabase
      .from('schedule_events')
      .select('id,title,scheduled_date,scheduled_time,location_label')
      .eq('org_id', orgId)
      .eq('event_type', 'one_time')
      .order('scheduled_date', { ascending: true })
      .limit(8),
    supabase
      .from('known_places')
      .select('id,label,address,lat,lng,visit_count,last_visit,typical_days')
      .eq('org_id', orgId)
      .order('visit_count', { ascending: false }),
  ]);

  if (soulResult.error?.code === '42501') redirect('/login');

  return (
    <>
      <Topbar title="Mi Perfil" subtitle="user profile · relationships · private vault · places" />
      <div className="flex-1 min-h-0">
        <ProfileHubClient
          personaContext={(soulResult.data?.persona_context ?? {}) as Record<string, unknown>}
          todos={todosResult.data ?? []}
          notes={notesResult.data ?? []}
          goals={goalsResult.data ?? []}
          privateItems={privateResult.data ?? []}
          scheduleEvents={scheduleResult.data ?? []}
          places={placesResult.data ?? []}
        />
      </div>
    </>
  );
}
