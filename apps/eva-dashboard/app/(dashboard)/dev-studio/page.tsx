'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Code2, Loader2, ChevronRight } from 'lucide-react';
import { devStudioApi } from '@/lib/dev-studio-api';
import type { DevSession } from '@/lib/dev-studio-types';
import { SessionStatusBadge } from '@/components/dev-studio/session-status-badge';

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
          onClick={() => setShowNew((s) => !s)}
          className="flex items-center gap-1.5 rounded-md bg-cyan-500/10 border border-cyan-500/20 px-3 py-1.5 text-xs font-medium text-cyan-400 hover:bg-cyan-500/20 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Nueva sesión
        </button>
      </div>

      {/* New session form */}
      {showNew && (
        <form
          onSubmit={handleCreate}
          className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-3"
        >
          <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest">nuevo proyecto</p>

          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Nombre del proyecto (opcional)"
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
          />

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={`Describe qué quieres construir con el mayor detalle posible.\n\nEj: Una plataforma SaaS de gestión de inventario con autenticación, roles, catálogo de productos, movimientos de stock, reportes y dashboard analytics. Stack: Next.js 14 + Supabase + TailwindCSS.`}
            rows={7}
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-700 resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
          />

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowNew(false)}
              className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={creating || !prompt.trim()}
              className="flex items-center gap-1.5 rounded-md bg-cyan-500 px-4 py-1.5 text-xs font-medium text-zinc-950 hover:bg-cyan-400 disabled:opacity-40 transition-colors"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Code2 className="h-3.5 w-3.5" />}
              {creating ? 'Creando…' : 'Iniciar proyecto'}
            </button>
          </div>
        </form>
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
          <div className="opacity-50">
            {done.map((s) => <SessionRow key={s.id} session={s} />)}
          </div>
        </section>
      )}

      {!loading && sessions.length === 0 && !showNew && (
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <Code2 className="h-8 w-8 text-zinc-800" />
          <p className="text-xs text-zinc-600">Sin sesiones de desarrollo activas</p>
          <button
            onClick={() => setShowNew(true)}
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

function SessionRow({ session }: { session: DevSession }) {
  const router = useRouter();
  const isActive = ['running', 'planning', 'awaiting_goals_approval'].includes(session.status);

  return (
    <button
      onClick={() => router.push(`/dev-studio/sessions/${session.id}`)}
      className="w-full flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-left hover:border-zinc-700 hover:bg-zinc-900 transition-colors group"
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
          <p className="text-[11px] text-zinc-600 truncate mt-0.5 italic">"{session.north_star}"</p>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[10px] text-zinc-700">
          {new Date(session.created_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-zinc-700 group-hover:text-zinc-400 transition-colors" />
      </div>
    </button>
  );
}
