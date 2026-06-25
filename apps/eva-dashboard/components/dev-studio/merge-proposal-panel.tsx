'use client';

import { useState } from 'react';
import { GitMerge, AlertTriangle, Check, X, ExternalLink, Rocket } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DevMergeProposal } from '@/lib/dev-studio-types';
import { devStudioApi } from '@/lib/dev-studio-api';

interface MergeProposalPanelProps {
  proposals: DevMergeProposal[];
  onUpdated?: () => void;
}

const RISK_COLOR: Record<string, string> = {
  low: 'text-emerald-400',
  medium: 'text-amber-400',
  high: 'text-red-400',
};

const OPEN_STATUSES = ['pending', 'conflicted', 'approved'];

export function MergeProposalPanel({ proposals, onUpdated }: MergeProposalPanelProps) {
  const open = proposals.filter((p) => OPEN_STATUSES.includes(p.status));
  const features = open.filter((p) => p.kind !== 'release');
  const releases = open.filter((p) => p.kind === 'release');
  if (open.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <GitMerge className="h-3.5 w-3.5 text-purple-400" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-purple-400">
          Pull Requests ({open.length})
        </span>
      </div>
      {releases.map((p) => <ReleaseCard key={p.id} proposal={p} />)}
      {features.map((p) => <MergeCard key={p.id} proposal={p} onUpdated={onUpdated} />)}
    </div>
  );
}

function PrLink({ proposal }: { proposal: DevMergeProposal }) {
  if (!proposal.pr_url) return null;
  return (
    <a
      href={proposal.pr_url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[10px] font-mono text-cyan-400 hover:underline"
    >
      PR #{proposal.pr_number} <ExternalLink className="h-2.5 w-2.5" />
    </a>
  );
}

/** Release PR (develop → main): approved through the Approval Engine, read-only here. */
function ReleaseCard({ proposal }: { proposal: DevMergeProposal }) {
  return (
    <div className="rounded-md border border-cyan-500/25 bg-cyan-500/5 px-3 py-2.5 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-cyan-300">
          <Rocket className="h-3.5 w-3.5" /> Release → producción
        </span>
        <PrLink proposal={proposal} />
      </div>
      <p className="text-xs text-zinc-400">
        <span className="font-mono text-zinc-300">{proposal.source_branch}</span>
        <span className="text-zinc-700 mx-1">→</span>
        <span className="font-mono text-zinc-300">{proposal.target_branch}</span>
      </p>
      <p className="text-[11px] text-amber-300/80">
        Esperando tu aprobación final en <a href="/approvals" className="underline">Approvals</a> para ir a prod.
      </p>
    </div>
  );
}

function MergeCard({ proposal, onUpdated }: { proposal: DevMergeProposal; onUpdated?: () => void }) {
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setLoading('approve');
    setError(null);
    try { await devStudioApi.approveMerge(proposal.id, notes); onUpdated?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(null); }
  }
  async function reject() {
    setLoading('reject');
    setError(null);
    try { await devStudioApi.rejectMerge(proposal.id, notes); onUpdated?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(null); }
  }

  const conflicted = proposal.status === 'conflicted';

  return (
    <div className={cn('rounded-md border px-3 py-2.5 space-y-2',
      conflicted ? 'border-red-500/25 bg-red-500/5' : 'border-purple-500/20 bg-purple-500/5')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-zinc-300">
            <span className="font-mono text-purple-400">{proposal.source_branch}</span>
            <span className="text-zinc-700 mx-1">→</span>
            <span className="font-mono text-zinc-500">{proposal.target_branch}</span>
          </p>
          <div className="flex items-center gap-2">
            {proposal.risk_level && (
              <span className={cn('text-[10px] font-mono', RISK_COLOR[proposal.risk_level] ?? 'text-zinc-500')}>
                riesgo: {proposal.risk_level}
              </span>
            )}
            {conflicted && <span className="text-[10px] font-mono text-red-400">conflicto — requiere tu decisión</span>}
            <PrLink proposal={proposal} />
          </div>
        </div>
        {(proposal.risk_level === 'high' || conflicted) && (
          <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
        )}
      </div>

      {proposal.diff_summary && <p className="text-xs text-zinc-500 whitespace-pre-wrap">{proposal.diff_summary}</p>}

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notas del revisor (opcional)…"
        rows={2}
        className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-700 resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
      />

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button onClick={approve} disabled={!!loading}
          className="flex-1 flex items-center justify-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 py-1.5 text-xs font-mono text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors">
          <Check className="h-3 w-3" />
          {loading === 'approve' ? '…' : conflicted ? 'Reintentar merge' : 'Aprobar y mergear'}
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
