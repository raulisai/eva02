import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Topbar } from '@/components/layout/topbar';
import { BillingClient } from '@/components/billing/billing-client';

export const metadata: Metadata = { title: 'Billing & Token Usage' };
export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const supabase = createClient();
  
  // Authenticate and get user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Resolve user's organization ID
  const { data: profile } = await supabase
    .from('users')
    .select('org_id')
    .eq('id', user.id)
    .single();
    
  if (!profile?.org_id) redirect('/login');

  // Fetch billing statistics via the safe database RPC
  const { data: stats, error } = await supabase.rpc('get_billing_stats', {
    p_org_id: profile.org_id,
  });

  if (error) {
    console.error('Failed to fetch billing stats:', error);
  }

  // Fallback to empty structure if RPC fails or returns null
  const initialStats = stats || {
    summary: { total_cost_usd: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, total_requests: 0 },
    by_model: [],
    by_type: [],
    by_day: [],
  };

  return (
    <>
      <Topbar title="Billing & Token Usage" subtitle="Track model consumption, costs, and token allocation" />
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <BillingClient initialStats={initialStats} orgId={profile.org_id} />
      </div>
    </>
  );
}
