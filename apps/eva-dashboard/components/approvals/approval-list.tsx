'use client';

import { useMemo, useState } from 'react';
import { Check, X, ShieldAlert, Timer, Hash } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn, shortId } from '@/lib/utils';
import type { Approval, ApprovalScreenshot } from '@/lib/types';

interface ApprovalListProps {
  initialApprovals: Approval[];
  screenshots: Record<string, ApprovalScreenshot>;
}

const statusVariant: Record<Approval['status'], 'pending' | 'completed' | 'failed' | 'cancelled'> = {
  pending: 'pending',
  approved: 'completed',
  rejected: 'failed',
  expired: 'cancelled',
};

export function ApprovalList({ initialApprovals, screenshots }: ApprovalListProps) {
  const [approvals, setApprovals] = useState(initialApprovals);
  const [busyId, setBusyId] = useState<string | null>(null);
  const pending = approvals.filter((approval) => approval.status === 'pending').length;
  const highRisk = approvals.filter((approval) => approval.level >= 2 && approval.status === 'pending').length;

  async function resolveApproval(id: string, decision: 'approve' | 'reject') {
    setBusyId(id);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Missing session');

      const res = await fetch(`${process.env.NEXT_PUBLIC_EVA_CORE_URL}/approvals/${id}/${decision}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: decision === 'reject' ? JSON.stringify({ reason: 'Rejected from dashboard' }) : undefined,
      });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      const updated = body.approval ?? body;
      setApprovals((prev) => prev.map((approval) => approval.id === id ? updated : approval));
    } finally {
      setBusyId(null);
    }
  }

  const ordered = useMemo(() => [...approvals].sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  }), [approvals]);

  return (
    <div className="flex flex-col h-full">
      <div className="grid grid-cols-3 gap-px border-b border-zinc-800 flex-shrink-0">
        <Metric label="Pending" value={pending} />
        <Metric label="High risk" value={highRisk} />
        <Metric label="Total" value={approvals.length} />
      </div>

      <div className="grid grid-cols-[160px_96px_1fr_220px] px-4 py-2 border-b border-zinc-800">
        {['Approval', 'Level', 'Action', 'Decision'].map((label) => (
          <span key={label} className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">{label}</span>
        ))}
      </div>

      <ScrollArea className="flex-1">
        {ordered.length === 0 && (
          <div className="h-56 flex items-center justify-center text-xs font-mono text-zinc-600">
            No approval requests
          </div>
        )}

        {ordered.map((approval) => {
          const shot = approval.screenshot_ref ? screenshots[approval.screenshot_ref] : undefined;
          const needsSecond = approval.level === 3 && approval.reviewed_by && !approval.reviewed_by_2;

          return (
            <div key={approval.id} className="grid grid-cols-[160px_96px_1fr_220px] gap-0 px-4 py-3 border-b border-zinc-800/70">
              <div className="space-y-2">
                <div className="font-mono text-xs text-zinc-300">{shortId(approval.id)}</div>
                <Badge variant={statusVariant[approval.status]}>{approval.status}</Badge>
              </div>

              <div className="flex items-start">
                <span className={cn(
                  'inline-flex h-7 w-7 items-center justify-center rounded-sm border font-mono text-xs',
                  approval.level >= 3 ? 'border-red-500/40 text-red-300 bg-red-500/10' :
                    approval.level === 2 ? 'border-orange-500/40 text-orange-300 bg-orange-500/10' :
                      'border-zinc-700 text-zinc-400 bg-zinc-900',
                )}>
                  L{approval.level}
                </span>
              </div>

              <div className="min-w-0 space-y-2 pr-4">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="text-xs text-zinc-200 truncate">{approval.action_type}</span>
                  <span className="font-mono text-[10px] text-zinc-600">{approval.source}</span>
                </div>
                {approval.summary && <p className="text-xs text-zinc-500 leading-relaxed">{approval.summary}</p>}
                <div className="flex items-center gap-2 font-mono text-[10px] text-zinc-600">
                  <Hash className="h-3 w-3" />
                  <span className="truncate">{approval.action_hash}</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[10px] text-zinc-600">
                  <Timer className="h-3 w-3" />
                  <span>{new Date(approval.expires_at).toLocaleString()}</span>
                  {needsSecond && <span className="text-orange-400">second approval required</span>}
                </div>
                {shot && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`data:${shot.mime_type};base64,${shot.image_base64}`}
                    alt="Approval screenshot"
                    className="mt-2 max-h-28 rounded-sm border border-zinc-800 object-contain"
                  />
                )}
              </div>

              <div className="flex items-start justify-end gap-2">
                <Button
                  size="sm"
                  onClick={() => resolveApproval(approval.id, 'approve')}
                  disabled={approval.status !== 'pending' || busyId === approval.id}
                >
                  <Check className="h-3.5 w-3.5" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => resolveApproval(approval.id, 'reject')}
                  disabled={approval.status !== 'pending' || busyId === approval.id}
                >
                  <X className="h-3.5 w-3.5" />
                  Reject
                </Button>
              </div>
            </div>
          );
        })}
      </ScrollArea>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-4 py-3 bg-zinc-950">
      <div className="text-[10px] uppercase tracking-widest text-zinc-600 font-mono">{label}</div>
      <div className="text-xl font-semibold text-zinc-100 mt-1">{value}</div>
    </div>
  );
}
