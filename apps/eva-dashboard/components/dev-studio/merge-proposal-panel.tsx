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
  low: 'text-emerald-600',
  medium: 'text-amber-600',
  high: 'text-red-600',
};

export function MergeProposalPanel({ proposals, onUpdated }: MergeProposalPanelProps) {
  const pending = proposals.filter((p) => p.status === 'pending');
  if (pending.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <GitMerge className="h-4 w-4 text-blue-500" />
        <span className="text-sm font-medium text-slate-700">
          Merge Proposals ({pending.length})
        </span>
      </div>
      {pending.map((p) => (
        <MergeCard key={p.id} proposal={p} onUpdated={onUpdated} />
      ))}
    </div>
  );
}

function MergeCard({ proposal, onUpdated }: { proposal: DevMergeProposal; onUpdated?: () => void }) {
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);

  async function approve() {
    setLoading('approve');
    try {
      await devStudioApi.approveMerge(proposal.id, notes);
      onUpdated?.();
    } finally {
      setLoading(null);
    }
  }

  async function reject() {
    setLoading('reject');
    try {
      await devStudioApi.rejectMerge(proposal.id, notes);
      onUpdated?.();
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-slate-800">
            <span className="font-mono text-blue-700">{proposal.source_branch}</span>
            {' → '}
            <span className="font-mono text-slate-600">{proposal.target_branch}</span>
          </p>
          {proposal.risk_level && (
            <span className={cn('text-xs font-medium', RISK_COLOR[proposal.risk_level] ?? 'text-slate-500')}>
              Riesgo: {proposal.risk_level}
            </span>
          )}
        </div>
        {proposal.risk_level === 'high' && (
          <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
        )}
      </div>

      {proposal.diff_summary && (
        <p className="text-sm text-slate-700">{proposal.diff_summary}</p>
      )}

      <div className="space-y-2">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notas del revisor (opcional)…"
          rows={2}
          className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <div className="flex gap-2">
          <button
            onClick={approve}
            disabled={!!loading}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            {loading === 'approve' ? 'Aprobando…' : 'Aprobar'}
          </button>
          <button
            onClick={reject}
            disabled={!!loading}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            {loading === 'reject' ? 'Rechazando…' : 'Rechazar'}
          </button>
        </div>
      </div>
    </div>
  );
}
