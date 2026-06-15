'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Code2, Loader2, ChevronRight } from 'lucide-react';
import { devStudioApi } from '@/lib/dev-studio-api';
import type { DevSession } from '@/lib/dev-studio-types';
import { SESSION_STATUS_LABEL } from '@/lib/dev-studio-types';
import { SessionStatusBadge } from '@/components/dev-studio/session-status-badge';

const EMPTY_STATE = `🚀 Sin sesiones de desarrollo activas.
Inicia un nuevo proyecto y el equipo de agentes se encarga del resto.`;

export default function DevStudioPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<DevSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');

  useEffect(() => {
    devStudioApi.listSessions().then(setSessions).finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setCreating(true);
    try {
      const session = await devStudioApi.createSession({ prompt, title: title || undefined });
      router.push(`/dev-studio/sessions/${session.id}`);
    } catch {
      setCreating(false);
    }
  }

  const active = sessions.filter((s) => !['completed', 'cancelled', 'failed'].includes(s.status));
  const done = sessions.filter((s) => ['completed', 'cancelled', 'failed'].includes(s.status));

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100">
            <Code2 className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Dev Studio</h1>
            <p className="text-sm text-slate-500">Desarrollo autónomo con equipo de agentes</p>
          </div>
        </div>

        <button
          onClick={() => setShowNew((s) => !s)}
          className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Nueva sesión
        </button>
      </div>

      {/* New session form */}
      {showNew && (
        <form
          onSubmit={handleCreate}
          className="rounded-2xl border border-blue-200 bg-blue-50 p-5 space-y-4"
        >
          <p className="text-sm font-semibold text-blue-800">Describe tu proyecto</p>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-600">Nombre (opcional)</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej: E-commerce con Next.js"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-600">Descripción detallada *</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`Describe qué quieres construir. Cuanto más detallado, mejor.

Ej: Quiero una plataforma de e-commerce con autenticación, catálogo de productos con búsqueda, carrito de compras, pagos con Stripe, panel de administración y dashboard de analytics. Stack: Next.js + Supabase + TailwindCSS.`}
              rows={6}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowNew(false)}
              className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={creating || !prompt.trim()}
              className="flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creando…
                </>
              ) : (
                <>
                  <Code2 className="h-4 w-4" />
                  Iniciar proyecto
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {/* Active sessions */}
      {!loading && active.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Activas ({active.length})
          </h2>
          <div className="space-y-2">
            {active.map((s) => (
              <SessionCard key={s.id} session={s} />
            ))}
          </div>
        </section>
      )}

      {/* Completed sessions */}
      {!loading && done.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Finalizadas ({done.length})
          </h2>
          <div className="space-y-2 opacity-70">
            {done.map((s) => (
              <SessionCard key={s.id} session={s} />
            ))}
          </div>
        </section>
      )}

      {/* Empty state */}
      {!loading && sessions.length === 0 && !showNew && (
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
          <div className="text-5xl">🤖</div>
          <p className="text-slate-500 whitespace-pre-line text-sm leading-relaxed">{EMPTY_STATE}</p>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Crear mi primer proyecto
          </button>
        </div>
      )}
    </div>
  );
}

function SessionCard({ session }: { session: DevSession }) {
  const router = useRouter();
  const isActive = ['running', 'planning', 'awaiting_goals_approval'].includes(session.status);

  return (
    <button
      onClick={() => router.push(`/dev-studio/sessions/${session.id}`)}
      className="w-full flex items-center gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left hover:border-blue-300 hover:bg-blue-50/40 transition-colors group"
    >
      {/* Pulse indicator */}
      <div className="relative flex-shrink-0">
        <div className={`h-2.5 w-2.5 rounded-full ${isActive ? 'bg-emerald-400' : 'bg-slate-200'}`} />
        {isActive && (
          <div className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-60" />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-800 truncate">{session.title}</span>
          <SessionStatusBadge status={session.status} />
        </div>
        {session.north_star && (
          <p className="text-xs text-slate-500 truncate mt-0.5">"{session.north_star}"</p>
        )}
        <p className="text-xs text-slate-400 mt-0.5">
          {new Date(session.created_at).toLocaleDateString('es-MX', {
            day: 'numeric', month: 'short', year: 'numeric',
          })}
        </p>
      </div>

      <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-blue-500 flex-shrink-0 transition-colors" />
    </button>
  );
}
