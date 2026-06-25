'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Code2, Loader2, ChevronRight, Trash2 } from 'lucide-react';
import { devStudioApi } from '@/lib/dev-studio-api';
import type { DevSession } from '@/lib/dev-studio-types';
import { SessionStatusBadge } from '@/components/dev-studio/session-status-badge';
import { ProjectPlanWizard } from '@/components/dev-studio/project-plan-wizard';

export default function DevStudioPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<DevSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    devStudioApi.listSessions().then(setSessions).finally(() => setLoading(false));
  }, []);

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await devStudioApi.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  function handleSessionCreated(sessionId: string) {
    router.push(`/dev-studio/sessions/${sessionId}`);
  }

  const active = sessions.filter((s) => !['completed', 'cancelled', 'failed'].includes(s.status));
  const done = sessions.filter((s) => ['completed', 'cancelled', 'failed'].includes(s.status));

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10 border border-cyan-500/20">
            <Code2 className="h-4 w-4 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-zinc-100">Dev Studio</h1>
            <p className="text-[11px] text-zinc-600">Desarrollo autónomo multi-agente</p>
          </div>
        </div>
        <button
          onClick={() => setShowWizard((s) => !s)}
          className="flex items-center gap-1.5 rounded-md bg-cyan-500/10 border border-cyan-500/20 px-3 py-1.5 text-xs font-medium text-cyan-400 hover:bg-cyan-500/20 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Nueva sesión
        </button>
      </div>

      {/* New session wizard */}
      {showWizard && (
        <ProjectPlanWizard
          onCreated={handleSessionCreated}
          onCancel={() => setShowWizard(false)}
        />
      )}

      {loading && (
        <div className="flex items-center justify-center py-16 text-zinc-700">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}

      {!loading && active.length > 0 && (
        <section className="space-y-1.5">
          <p className="text-[9px] font-mono uppercase tracking-widest text-zinc-700 px-1">
            Activas — {active.length}
          </p>
          {active.map((s) => <SessionRow key={s.id} session={s} />)}
        </section>
      )}

      {!loading && done.length > 0 && (
        <section className="space-y-1.5">
          <p className="text-[9px] font-mono uppercase tracking-widest text-zinc-700 px-1">
            Finalizadas — {done.length}
          </p>
          <div className="opacity-60 space-y-1.5">
            {done.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                onDelete={handleDelete}
                deleting={deletingId === s.id}
              />
            ))}
          </div>
        </section>
      )}

      {!loading && sessions.length === 0 && !showWizard && (
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <Code2 className="h-8 w-8 text-zinc-800" />
          <p className="text-xs text-zinc-600">Sin sesiones de desarrollo activas</p>
          <button
            onClick={() => setShowWizard(true)}
            className="flex items-center gap-1.5 rounded-md border border-zinc-800 px-4 py-2 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Crear primer proyecto
          </button>
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  onDelete,
  deleting,
}: {
  session: DevSession;
  onDelete?: (id: string) => void;
  deleting?: boolean;
}) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isActive = ['running', 'planning', 'awaiting_goals_approval'].includes(session.status);
  const isDone = ['completed', 'cancelled', 'failed'].includes(session.status);

  return (
    <div className="relative group">
      <button
        onClick={() => router.push(`/dev-studio/sessions/${session.id}`)}
        className="w-full flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-left hover:border-zinc-700 hover:bg-zinc-900 transition-colors"
      >
        <div className="relative shrink-0">
          <div className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-cyan-400' : 'bg-zinc-700'}`} />
          {isActive && (
            <div className="absolute inset-0 rounded-full bg-cyan-400 animate-ping opacity-50" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-200 truncate">{session.title}</span>
            <SessionStatusBadge status={session.status} />
          </div>
          {session.north_star && (
            <p className="text-[11px] text-zinc-600 truncate mt-0.5 italic">&quot;{session.north_star}&quot;</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-zinc-700">
            {new Date(session.created_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-zinc-700 group-hover:text-zinc-400 transition-colors" />
        </div>
      </button>

      {/* Delete button — only for terminal sessions */}
      {isDone && onDelete && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {confirmDelete ? (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(session.id); setConfirmDelete(false); }}
                disabled={deleting}
                className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-mono bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 transition-colors disabled:opacity-40"
              >
                {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : '¿Eliminar?'}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                className="rounded px-2 py-1 text-[10px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                No
              </button>
            </>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
              className="opacity-0 group-hover:opacity-100 rounded p-1 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
              title="Eliminar sesión"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
