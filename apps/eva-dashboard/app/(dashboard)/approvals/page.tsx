import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { Topbar } from '@/components/layout/topbar';
import { ApprovalList } from '@/components/approvals/approval-list';
import type { Approval, ApprovalScreenshot } from '@/lib/types';

export const metadata: Metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const supabase = createClient();
  const { data: approvals } = await supabase
    .from('approvals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  const screenshotIds = (approvals ?? [])
    .map((approval) => approval.screenshot_ref)
    .filter(Boolean) as string[];

  const { data: screenshotRows } = screenshotIds.length
    ? await supabase
      .from('browser_screenshots')
      .select('id,image_base64,mime_type')
      .in('id', screenshotIds)
    : { data: [] };

  const screenshots = Object.fromEntries(
    ((screenshotRows ?? []) as ApprovalScreenshot[]).map((shot) => [shot.id, shot]),
  );

  return (
    <>
      <Topbar title="Approvals" subtitle={`${approvals?.length ?? 0} loaded · action_hash + nonce`} />
      <div className="flex-1 min-h-0">
        <ApprovalList
          initialApprovals={(approvals ?? []) as Approval[]}
          screenshots={screenshots}
        />
      </div>
    </>
  );
}
