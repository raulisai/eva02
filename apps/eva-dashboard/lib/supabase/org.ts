import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export async function requireOrgContext() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('users')
    .select('org_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.org_id) redirect('/login');
  return { supabase, orgId: profile.org_id as string };
}
