import type { Metadata } from 'next';
import { requireOrgContext } from '@/lib/supabase/org';
import { Topbar } from '@/components/layout/topbar';
import { JobsClient } from '@/components/jobs/jobs-client';
import type { ScheduledJob } from '@/lib/types';

export const metadata: Metadata = { title: 'Jobs' };
export const dynamic = 'force-dynamic';

export default async function JobsPage() {
  const { supabase, orgId } = await requireOrgContext();

  const { data: jobs } = await supabase
    .from('scheduled_jobs')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });

  const active = (jobs ?? []).filter((j) => j.status === 'active').length;

  return (
    <>
      <Topbar
        title="Scheduled Jobs"
        subtitle={`${active} active · ${jobs?.length ?? 0} total`}
      />
      <div className="flex-1 min-h-0">
        <JobsClient initialJobs={(jobs ?? []) as ScheduledJob[]} />
      </div>
    </>
  );
}
