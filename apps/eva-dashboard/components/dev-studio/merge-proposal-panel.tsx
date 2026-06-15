'use client';

import { useState } from 'react';
import { GitMerge, AlertTriangle, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DevMergeProposal } from '@/lib/dev-studio-types';
import { devStudioApi } from '@/lib/dev-studio-api';

interface MergeProposalPanelProps {
  proposals: DevMergeProposal[];
  onUpdated?: () => void;
}

const RISK_COLOR: Record<string, string> = {
  low:    'text-emerald-400',
  medium: 'text-amber-400',
  high:   'text-red-400',
};

export function MergeProposalPanel({ proposals, onUpdated }: MergeProposalPanelProps) {
  const pending = proposals.filter((p) => p.status === 'pending');
  if (pending.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <GitMerge className="h-3.5 w-3.5 text-purple-400" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-purple-400">
          Merge proposals ({pending.length})
        </span>
      </div>
      {pending.map((p) => <MergeCard key={p.id} proposal={p} onUpdated={onUpdated} />)}
    </div>
  );
}

function MergeCard({ proposal, onUpdated }: { proposal: DevMergeProposal; onUpdated?: () => void }) {
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);

  async function approve() {
    setLoading('approve');
    try { await devStudioApi.approveMerge(proposal.id, notes); onUpdated?.(); }
    finally { setLoading(null); }
  }
  async function reject() {
    setLoading('reject');
    try { await devStudioApi.rejectMerge(proposal.id, notes); onUpdated?.(); }
    finally { setLoading(null); }
  }

  return (
    <div className="rounded-md border border-purple-500/20 bg-purple-500/5 px-3 py-2.5 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-zinc-300">
            <span className="font-mono text-purple-400">{proposal.source_branch}</span>
            <span className="text-zinc-700 mx-1">→</span>
            <span className="font-mono text-zinc-500">{proposal.target_branch}</span>
          </p>
          {proposal.risk_level && (
            <span className={cn('text-[10px] font-mono', RISK_COLOR[proposal.risk_level] ?? 'text-zinc-500')}>
              riesgo: {proposal.risk_level}
            </span>
          )}
        </div>
        {proposal.risk_level === 'high' && (
          <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
        )}
      </div>

      {proposal.diff_summary && (
        <p className="text-xs text-zinc-500">{proposal.diff_summary}</p>
      )}

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notas del revisor (opcional)…"
        rows={2}
        className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-700 resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
      />

      <div className="flex gap-2">
        <button onClick={approve} disabled={!!loading}
          className="flex-1 flex items-center justify-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 py-1.5 text-xs font-mono text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors">
          <Check className="h-3 w-3" />
          {loading === 'approve' ? '…' : 'Aprobar'}
        </button>
        <button onClick={reject} disabled={!!loading}
          className="flex-1 flex items-center justify-center gap-1 rounded border border-red-500/20 bg-red-500/5 py-1.5 text-xs font-mono text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition-colors">
          <X className="h-3 w-3" />
          {loading === 'reject' ? '…' : 'Rechazar'}
        </button>
      </div>
    </div>
  );
}
