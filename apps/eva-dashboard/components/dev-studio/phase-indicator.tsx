'use client';

import { cn } from '@/lib/utils';
import type { DevSession, DevMergeProposal } from '@/lib/dev-studio-types';

/**
 * "Fase del desarrollo" strip: maps the session status + live PR state to the
 * repo-centric pipeline so the user always sees where the project is.
 */
const PHASES = [
  { key: 'planning', label: 'Planeando' },
  { key: 'building', label: 'Construyendo' },
  { key: 'review', label: 'Revisión arquitecto' },
  { key: 'integrated', label: 'Integrado (develop)' },
  { key: 'release', label: 'Revisión release' },
  { key: 'prod', label: 'Producción' },
] as const;

type PhaseKey = (typeof PHASES)[number]['key'];

function derivePhase(session: DevSession, proposals: DevMergeProposal[]): PhaseKey {
  const status = session.status;
  if (['completed'].includes(status)) return 'prod';

  const releaseOpen = proposals.some((p) => p.kind === 'release' && ['pending', 'approved'].includes(p.status));
  if (releaseOpen || status === 'ready_for_release' || status === 'ready_for_deploy' || status === 'waiting_for_human_review') {
    return 'release';
  }

  if (['idea_intake', 'planning', 'awaiting_goals_approval', 'awaiting_architecture_approval'].includes(status)) {
    return 'planning';
  }

  const featurePending = proposals.some((p) => p.kind !== 'release' && p.status === 'pending');
  if (featurePending) return 'review';

  const anyMerged = proposals.some((p) => p.kind !== 'release' && p.status === 'merged');
  if (anyMerged) return 'integrated';

  return 'building';
}

export function PhaseIndicator({ session, proposals }: { session: DevSession; proposals: DevMergeProposal[] }) {
  const current = derivePhase(session, proposals);
  const currentIdx = PHASES.findIndex((p) => p.key === current);

  const openFeaturePrs = proposals.filter((p) => p.kind !== 'release' && p.status === 'pending').length;
  const mergedPrs = proposals.filter((p) => p.kind !== 'release' && p.status === 'merged').length;

  return (
    <div className="rounded-md border border-white/5 bg-[#0b1224] px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Fase del desarrollo</span>
        <span className="text-[10px] font-mono text-zinc-600">
          {mergedPrs} PR integrados{openFeaturePrs > 0 ? ` · ${openFeaturePrs} en revisión` : ''}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {PHASES.map((phase, i) => {
          const done = i < currentIdx;
          const active = i === currentIdx;
          return (
            <div key={phase.key} className="flex items-center gap-1 flex-1 last:flex-none">
              <div className="flex flex-col items-center gap-1 min-w-0">
                <div
                  className={cn(
                    'h-2 w-2 rounded-full shrink-0',
                    active ? 'bg-cyan-400 ring-2 ring-cyan-400/30' : done ? 'bg-emerald-500/70' : 'bg-zinc-700',
                  )}
                />
                <span
                  className={cn(
                    'text-[9px] font-mono text-center leading-tight truncate max-w-[72px]',
                    active ? 'text-cyan-400' : done ? 'text-emerald-500/80' : 'text-zinc-600',
                  )}
                >
                  {phase.label}
                </span>
              </div>
              {i < PHASES.length - 1 && (
                <div className={cn('h-px flex-1 min-w-[8px]', i < currentIdx ? 'bg-emerald-500/40' : 'bg-zinc-800')} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
