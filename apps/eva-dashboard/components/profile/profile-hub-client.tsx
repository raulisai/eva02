'use client';

import { useMemo, useState } from 'react';
import {
  BriefcaseBusiness, CalendarDays, CheckCircle2, Eye, EyeOff, Flag,
  KeyRound, Loader2, LockKeyhole, Plus, Shield, StickyNote, UserRound, Users,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { coreFetch } from '@/lib/core-api';
import { cn } from '@/lib/utils';

type Json = Record<string, unknown>;

interface ProfileTodo {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  due_date: string | null;
  priority: number;
  sensitivity: string;
  sensitive_hint: string | null;
}

interface ProfileNote {
  id: string;
  title: string | null;
  content: string;
  pinned: boolean;
  sensitivity: string;
  sensitive_hint: string | null;
}

interface ProfileGoal {
  id: string;
  title: string;
  description: string | null;
  status: string;
  deadline: string | null;
  progress: number;
  category: string | null;
  sensitivity: string;
  sensitive_hint: string | null;
}

interface PrivateItem {
  id: string;
  kind: string;
  label: string;
  hint: string;
  sensitivity: string;
}

interface ScheduleEvent {
  id: string;
  title: string;
  scheduled_date: string | null;
  scheduled_time: string | null;
  location_label: string | null;
}

interface ProfileHubClientProps {
  personaContext: Json;
  todos: ProfileTodo[];
  notes: ProfileNote[];
  goals: ProfileGoal[];
  privateItems: PrivateItem[];
  scheduleEvents: ScheduleEvent[];
}

export function ProfileHubClient({
  personaContext,
  todos,
  notes,
  goals,
  privateItems,
  scheduleEvents,
}: ProfileHubClientProps) {
  const [vault, setVault] = useState(privateItems);
  const [privateDraft, setPrivateDraft] = useState({ kind: 'note', label: '', value: '' });
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const personalProfile = (personaContext.personal_profile ?? {}) as Json;
  const coworkContext = (personaContext.cowork_context ?? {}) as Json;
  const relationships = Array.isArray(personaContext.relationship_map)
    ? personaContext.relationship_map as Array<Json>
    : [];

  const stats = useMemo(() => [
    { label: 'Pendientes', value: todos.filter((todo) => todo.status !== 'done').length },
    { label: 'Metas activas', value: goals.filter((goal) => goal.status === 'active').length },
    { label: 'Notas visibles', value: notes.length },
    { label: 'Privados', value: vault.length },
  ], [goals, notes.length, todos, vault.length]);

  async function addPrivateItem() {
    if (!privateDraft.label.trim() || !privateDraft.value.trim()) return;
    setBusyId('new-private');
    setFeedback(null);
    try {
      const created = await coreFetch('/agent/profile/private-items', {
        method: 'POST',
        body: JSON.stringify(privateDraft),
      }) as PrivateItem;
      setVault((prev) => [created, ...prev]);
      setPrivateDraft({ kind: 'note', label: '', value: '' });
      setFeedback({ ok: true, text: 'Dato privado guardado cifrado' });
    } catch (error) {
      setFeedback({ ok: false, text: (error as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function reveal(item: PrivateItem) {
    if (revealed[item.id]) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      return;
    }
    setBusyId(item.id);
    setFeedback(null);
    try {
      const result = await coreFetch(`/agent/profile/private-items/${item.id}/reveal`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'dashboard_profile_reveal' }),
      }) as { value: string };
      setRevealed((prev) => ({ ...prev, [item.id]: result.value }));
    } catch (error) {
      setFeedback({ ok: false, text: (error as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-7xl space-y-5 p-5">
        <section className="grid gap-3 border-b border-zinc-800 pb-5 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-sm border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                <UserRound className="h-4 w-4" />
              </div>
              <div>
                <p className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Mi Perfil</p>
                <h2 className="text-lg font-semibold text-zinc-100">
                  {text(personalProfile.full_name) || 'Perfil del usuario'}
                </h2>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label} className="border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">{stat.label}</p>
                  <p className="mt-1 text-xl font-semibold text-zinc-100">{stat.value}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Fact label="Como llamarte" value={text(personalProfile.preferred_address)} />
            <Fact label="Ubicacion" value={text(personalProfile.current_location)} />
            <Fact label="Trabajo" value={text(personalProfile.workplace) || text(personalProfile.occupation)} />
            <Fact label="Expectativas" value={text(personaContext.expectations)} />
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <main className="space-y-5">
            <Section icon={BriefcaseBusiness} title="Contexto Operativo">
              <div className="grid gap-2 md:grid-cols-2">
                <Fact label="Horarios" value={text(coworkContext.work_hours) || text(personaContext.work_hours)} />
                <Fact label="Dias libres" value={text(coworkContext.days_off) || text(personaContext.days_off)} />
                <Fact label="Rutinas" value={text(coworkContext.routines) || text(personaContext.routines)} />
                <Fact label="Comunicacion" value={text(coworkContext.communication_preferences) || text(personaContext.communication_preferences)} />
              </div>
            </Section>

            <Section icon={Users} title="Mapa de Familiares y Contactos">
              <div className="grid gap-2 md:grid-cols-2">
                {relationships.length === 0 && <Empty text="Sin relaciones mapeadas todavia." />}
                {relationships.map((entry, index) => (
                  <div key={String(entry.id ?? index)} className="border border-zinc-800 bg-zinc-950/60 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-zinc-100">{text(entry.display_name) || 'Contacto'}</p>
                        <p className="font-mono text-[10px] uppercase tracking-wider text-emerald-300">{text(entry.relation) || 'relacion'}</p>
                      </div>
                      <Badge variant="default">{Array.isArray(entry.aliases) ? entry.aliases.length : 0} aliases</Badge>
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs text-zinc-500">{text(entry.contact_hint) || text(entry.notes) || 'Sin notas visibles'}</p>
                  </div>
                ))}
              </div>
            </Section>

            <section className="grid gap-5 lg:grid-cols-2">
              <Section icon={CheckCircle2} title="Pendientes">
                <ItemList items={todos} empty="Sin pendientes estructurados." render={(todo) => (
                  <ProfileItem key={todo.id} title={safeText(todo.title, todo)} meta={`${todo.status} · P${todo.priority}`} body={todo.notes} />
                )} />
              </Section>

              <Section icon={Flag} title="Metas">
                <ItemList items={goals} empty="Sin metas estructuradas." render={(goal) => (
                  <ProfileItem key={goal.id} title={safeText(goal.title, goal)} meta={`${goal.status} · ${goal.progress}%`} body={goal.description ?? goal.category} />
                )} />
              </Section>
            </section>

            <section className="grid gap-5 lg:grid-cols-2">
              <Section icon={StickyNote} title="Notas">
                <ItemList items={notes} empty="Sin notas." render={(note) => (
                  <ProfileItem key={note.id} title={safeText(note.title || 'Nota', note)} meta={note.pinned ? 'pinned' : 'note'} body={safeText(note.content, note)} />
                )} />
              </Section>

              <Section icon={CalendarDays} title="Agenda Proxima">
                <ItemList items={scheduleEvents} empty="Sin eventos proximos." render={(event) => (
                  <ProfileItem key={event.id} title={event.title} meta={[event.scheduled_date, event.scheduled_time].filter(Boolean).join(' ')} body={event.location_label} />
                )} />
              </Section>
            </section>
          </main>

          <aside className="space-y-5">
            <Section icon={LockKeyhole} title="Boveda Privada">
              <div className="space-y-2">
                <input
                  value={privateDraft.label}
                  onChange={(event) => setPrivateDraft((prev) => ({ ...prev, label: event.target.value }))}
                  placeholder="Etiqueta"
                  className="w-full rounded-sm border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400/60 focus:outline-none"
                />
                <textarea
                  value={privateDraft.value}
                  onChange={(event) => setPrivateDraft((prev) => ({ ...prev, value: event.target.value }))}
                  rows={4}
                  placeholder="Dato privado para EVA"
                  className="w-full resize-y rounded-sm border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400/60 focus:outline-none"
                />
                <Button type="button" onClick={addPrivateItem} disabled={busyId === 'new-private'}>
                  {busyId === 'new-private' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Guardar cifrado
                </Button>
              </div>

              <div className="space-y-2 pt-2">
                {vault.length === 0 && <Empty text="Sin datos privados cifrados." />}
                {vault.map((item) => (
                  <div key={item.id} className="border border-amber-500/20 bg-amber-500/5 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-amber-100">{item.label}</p>
                        <p className="mt-1 font-mono text-[10px] text-amber-300/70">{item.hint}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => reveal(item)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-sm border border-amber-400/30 text-amber-200 hover:bg-amber-400/10"
                        aria-label={revealed[item.id] ? 'Ocultar dato privado' : 'Revelar dato privado'}
                      >
                        {busyId === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : revealed[item.id] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    {revealed[item.id] && (
                      <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap border border-amber-500/20 bg-zinc-950/80 p-2 text-[11px] text-zinc-100">
                        {revealed[item.id]}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </Section>

            <Section icon={Shield} title="Privacidad">
              <div className="space-y-2 text-[11px] leading-relaxed text-zinc-500">
                <p>La tabla publica solo expone hints; el valor privado se revela por eva-core y queda auditado.</p>
                <p>Los datos clasificados como sensibles se guardan como texto enmascarado y copia cifrada.</p>
              </div>
            </Section>
          </aside>
        </div>

        {feedback && (
          <div className={cn(
            'fixed bottom-4 right-4 z-20 flex items-center gap-2 rounded-sm border bg-zinc-950 px-3 py-2 font-mono text-xs shadow-lg',
            feedback.ok ? 'border-emerald-500/30 text-emerald-400' : 'border-red-500/30 text-red-400',
          )}>
            {feedback.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
            {feedback.text}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof UserRound; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-2">
        <Icon className="h-3.5 w-3.5 text-emerald-300" />
        <h3 className="text-xs font-semibold text-zinc-100">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">{label}</p>
      <p className="mt-1 line-clamp-2 text-xs text-zinc-200">{value || 'Sin dato'}</p>
    </div>
  );
}

function Empty({ text: value }: { text: string }) {
  return <div className="border border-dashed border-zinc-800 px-3 py-4 text-xs text-zinc-500">{value}</div>;
}

function ItemList<T>({ items, empty, render }: { items: T[]; empty: string; render: (item: T) => React.ReactNode }) {
  if (items.length === 0) return <Empty text={empty} />;
  return <div className="space-y-2">{items.map(render)}</div>;
}

function ProfileItem({ title, meta, body }: { title: string; meta: string; body?: string | null }) {
  return (
    <div className="border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-zinc-100">{title}</p>
        <span className="whitespace-nowrap font-mono text-[10px] text-zinc-600">{meta}</span>
      </div>
      {body && <p className="mt-2 line-clamp-2 text-xs text-zinc-500">{body}</p>}
    </div>
  );
}

function safeText(value: string | null, item: { sensitivity: string; sensitive_hint: string | null }) {
  return item.sensitivity === 'sensitive' ? item.sensitive_hint ?? 'Dato privado' : value ?? '';
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}
