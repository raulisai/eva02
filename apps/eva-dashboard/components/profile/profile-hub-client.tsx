'use client';

import { useCallback, useRef, useState } from 'react';
import {
  BriefcaseBusiness, CalendarDays, CheckCircle2, Flag, Heart,
  KeyRound, Loader2, LockKeyhole, MapPin, Plus, Shield,
  StickyNote, Trash2, UserRound, Users, X, XCircle,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { coreFetch } from '@/lib/core-api';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

interface ProfileTodo {
  id: string; title: string; notes: string | null;
  status: string; due_date: string | null; priority: number;
  sensitivity: string; sensitive_hint: string | null;
}
interface ProfileNote {
  id: string; title: string | null; content: string;
  pinned: boolean; sensitivity: string; sensitive_hint: string | null;
}
interface ProfileGoal {
  id: string; title: string; description: string | null;
  status: string; deadline: string | null; progress: number;
  category: string | null; sensitivity: string; sensitive_hint: string | null;
}
interface PrivateItem {
  id: string; kind: string; label: string; hint: string; sensitivity: string;
}
interface ScheduleEvent {
  id: string; title: string; scheduled_date: string | null;
  scheduled_time: string | null; location_label: string | null;
}
interface KnownPlace {
  id: string; label: string; address: string | null;
  lat: number | null; lng: number | null;
  visit_count: number; last_visit: string | null; typical_days: string[] | null;
}
interface RelationshipEntry {
  id: string; display_name: string; relation: string;
  aliases: string[]; contact_hint?: string; notes?: string;
}

interface ProfileHubClientProps {
  personaContext: Json;
  todos: ProfileTodo[];
  notes: ProfileNote[];
  goals: ProfileGoal[];
  privateItems: PrivateItem[];
  scheduleEvents: ScheduleEvent[];
  places: KnownPlace[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAYS = [
  { key: 'lun', label: 'L', full: 'Lunes' },
  { key: 'mar', label: 'M', full: 'Martes' },
  { key: 'mie', label: 'M', full: 'Miércoles' },
  { key: 'jue', label: 'J', full: 'Jueves' },
  { key: 'vie', label: 'V', full: 'Viernes' },
  { key: 'sab', label: 'S', full: 'Sábado' },
  { key: 'dom', label: 'D', full: 'Domingo' },
];

const VAULT_KINDS = [
  { value: 'card', label: 'Tarjeta / cuenta' },
  { value: 'password', label: 'Contraseña' },
  { value: 'document', label: 'Documento' },
  { value: 'medical', label: 'Médico / salud' },
  { value: 'note', label: 'Nota privada' },
  { value: 'other', label: 'Otro' },
];

function str(v: unknown): string { return String(v ?? '').trim(); }

function parseAge(v: string): number {
  const n = parseInt(v, 10);
  return isNaN(n) || n < 16 || n > 85 ? 25 : n;
}

function parseTime(v: string): [string, string] {
  const m = v.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
  if (m) return [m[1].padStart(5, '0'), m[2].padStart(5, '0')];
  return ['09:00', '18:00'];
}

function parseDays(v: string): string[] {
  if (!v) return ['lun', 'mar', 'mie', 'jue', 'vie'];
  return v.split(',').map(d => d.trim()).filter(Boolean);
}

function parseTags(v: string): string[] {
  return v.split(',').map(t => t.trim()).filter(Boolean);
}

function timeToPercent(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return ((h * 60 + m) / (24 * 60)) * 100;
}

function formatDuration(start: string, end: string): string {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const min = mins % 60;
  return min ? `${h}h ${min}m` : `${h}h`;
}

// ── Styles injected once ──────────────────────────────────────────────────────

const CSS = `
@keyframes slideUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes pop{0%{transform:scale(1)}50%{transform:scale(1.12)}100%{transform:scale(1)}}
@keyframes shimmer{0%{opacity:1}50%{opacity:0.5}100%{opacity:1}}
.anim-slide-up{animation:slideUp 0.22s ease both}
.anim-fade-in{animation:fadeIn 0.18s ease both}
.anim-pop{animation:pop 0.25s ease both}
.profile-slider{-webkit-appearance:none;appearance:none;height:6px;border-radius:3px;outline:none;cursor:pointer;width:100%;transition:opacity 0.2s}
.profile-slider::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:#10b981;cursor:pointer;border:3px solid #052e16;box-shadow:0 0 0 2px rgba(16,185,129,0.3);transition:box-shadow 0.2s,transform 0.15s}
.profile-slider::-webkit-slider-thumb:hover{box-shadow:0 0 0 6px rgba(16,185,129,0.25);transform:scale(1.1)}
.profile-slider::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:#10b981;cursor:pointer;border:3px solid #052e16}
.profile-slider::-moz-range-progress{background:#10b981;height:6px;border-radius:3px}
.time-bar{height:8px;border-radius:4px;background:#27272a;position:relative;overflow:hidden}
.time-bar-fill{position:absolute;top:0;bottom:0;background:rgba(16,185,129,0.35);border-radius:4px;transition:left 0.3s ease,width 0.3s ease}
.time-bar-edge{position:absolute;top:50%;transform:translateY(-50%);width:3px;height:14px;background:#10b981;border-radius:2px;transition:left 0.3s ease}
.day-pill{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;cursor:pointer;border:1.5px solid transparent;transition:background 0.18s,color 0.18s,border-color 0.18s,transform 0.15s,box-shadow 0.15s;user-select:none}
.day-pill:hover{transform:scale(1.08)}
.day-pill.active{background:#10b981;color:#052e16;border-color:#059669;box-shadow:0 0 0 3px rgba(16,185,129,0.2)}
.day-pill.inactive{background:#27272a;color:#71717a;border-color:#3f3f46}
.day-pill.inactive:hover{border-color:#52525b;color:#a1a1aa}
.tag-chip{display:inline-flex;align-items:center;gap:4px;background:#1c1917;border:1px solid #44403c;border-radius:4px;padding:2px 8px 2px 10px;font-size:11px;color:#d6d3d1;transition:border-color 0.15s}
.tag-chip:hover{border-color:#78716c}
.input-field{width:100%;background:#09090b;border:1px solid #3f3f46;border-radius:4px;padding:8px 12px;font-size:12px;color:#f4f4f5;outline:none;transition:border-color 0.18s;font-family:inherit}
.input-field:focus{border-color:rgba(16,185,129,0.5)}
.input-field::placeholder{color:#52525b}
.select-field{width:100%;background:#09090b;border:1px solid #3f3f46;border-radius:4px;padding:8px 12px;font-size:12px;color:#f4f4f5;outline:none;cursor:pointer;transition:border-color 0.18s;font-family:inherit}
.select-field:focus{border-color:rgba(16,185,129,0.5)}
.saved-flash{color:#10b981;animation:shimmer 0.8s ease}
`;

// ── Main Component ────────────────────────────────────────────────────────────

export function ProfileHubClient({
  personaContext: initialCtx,
  todos: initialTodos,
  notes: initialNotes,
  goals: initialGoals,
  privateItems: initialVault,
  scheduleEvents,
  places: initialPlaces,
}: ProfileHubClientProps) {
  const [ctx, setCtx] = useState(initialCtx);
  const [todos, setTodos] = useState(initialTodos);
  const [notes, setNotes] = useState(initialNotes);
  const [goals, setGoals] = useState(initialGoals);
  const [vault, setVault] = useState(initialVault);
  const [places, setPlaces] = useState(initialPlaces);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const profile = (ctx.personal_profile ?? {}) as Json;
  const cowork = (ctx.cowork_context ?? {}) as Json;
  const relations = Array.isArray(ctx.relationship_map) ? ctx.relationship_map as RelationshipEntry[] : [];

  const showToast = useCallback((ok: boolean, text: string) => {
    setToast({ ok, text });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const flash = useCallback((id: string) => {
    setSavedId(id);
    setTimeout(() => setSavedId(null), 1600);
  }, []);

  // ── Field save ──────────────────────────────────────────────────────────────

  async function saveField(key: string, value: string, section: 'personal_profile' | 'cowork_context' | 'persona_context') {
    const bid = `${section}.${key}`;
    setBusyId(bid);
    try {
      await coreFetch('/agent/profile/persona', {
        method: 'PATCH',
        body: JSON.stringify({ key, value, section }),
      });
      setCtx(prev => {
        if (section === 'personal_profile' || section === 'cowork_context') {
          return { ...prev, [section]: { ...((prev[section] ?? {}) as Json), [key]: value } };
        }
        return { ...prev, [key]: value };
      });
      flash(bid);
    } catch (e) {
      showToast(false, (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  // ── Age slider ──────────────────────────────────────────────────────────────

  const [age, setAge] = useState(() => parseAge(str(profile.age)));

  // ── Work schedule ───────────────────────────────────────────────────────────

  const [startT, endT] = parseTime(str(cowork.work_hours));
  const [localStart, setLocalStart] = useState(startT);
  const [localEnd, setLocalEnd] = useState(endT);
  const [days, setDays] = useState(() => parseDays(str(cowork.work_days)));

  async function toggleDay(key: string) {
    const next = days.includes(key) ? days.filter(d => d !== key) : [...days, key];
    setDays(next);
    await saveField('work_days', next.join(','), 'cowork_context');
  }

  async function commitTime() {
    await saveField('work_hours', `${localStart}-${localEnd}`, 'cowork_context');
  }

  // ── Tags ────────────────────────────────────────────────────────────────────

  const [likeTags, setLikeTags] = useState(() => parseTags(str(profile.likes)));
  const [hobbyTags, setHobbyTags] = useState(() => parseTags(str(profile.hobbies)));

  async function saveTagField(tags: string[], key: string, setter: (t: string[]) => void) {
    setter(tags);
    await saveField(key, tags.join(', '), 'personal_profile');
  }

  // ── Todos ───────────────────────────────────────────────────────────────────

  const [showTodoForm, setShowTodoForm] = useState(false);
  const [todoDraft, setTodoDraft] = useState({ title: '', priority: '2' });

  async function addTodo() {
    if (!todoDraft.title.trim()) return;
    setBusyId('new-todo');
    try {
      const created = await coreFetch('/agent/profile/facts', {
        method: 'POST',
        body: JSON.stringify({ type: 'todo', payload: { title: todoDraft.title, priority: Number(todoDraft.priority), confidence: 1 }, source: 'manual' }),
      }) as ProfileTodo;
      setTodos(p => [{ ...created, _new: true } as ProfileTodo, ...p]);
      setTodoDraft({ title: '', priority: '2' });
      setShowTodoForm(false);
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  async function deleteTodo(id: string) {
    setBusyId(id);
    try {
      await coreFetch(`/agent/profile/todos/${id}`, { method: 'DELETE' });
      setTodos(p => p.filter(t => t.id !== id));
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  // ── Notes ───────────────────────────────────────────────────────────────────

  const [showNoteForm, setShowNoteForm] = useState(false);
  const [noteDraft, setNoteDraft] = useState({ title: '', content: '' });

  async function addNote() {
    if (!noteDraft.content.trim()) return;
    setBusyId('new-note');
    try {
      const created = await coreFetch('/agent/profile/facts', {
        method: 'POST',
        body: JSON.stringify({ type: 'note', payload: { title: noteDraft.title, content: noteDraft.content, confidence: 1 }, source: 'manual' }),
      }) as ProfileNote;
      setNotes(p => [created, ...p]);
      setNoteDraft({ title: '', content: '' });
      setShowNoteForm(false);
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  async function deleteNote(id: string) {
    setBusyId(id);
    try {
      await coreFetch(`/agent/profile/notes/${id}`, { method: 'DELETE' });
      setNotes(p => p.filter(n => n.id !== id));
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  // ── Goals ───────────────────────────────────────────────────────────────────

  const [showGoalForm, setShowGoalForm] = useState(false);
  const [goalDraft, setGoalDraft] = useState({ title: '', description: '', category: '' });

  async function addGoal() {
    if (!goalDraft.title.trim()) return;
    setBusyId('new-goal');
    try {
      const created = await coreFetch('/agent/profile/facts', {
        method: 'POST',
        body: JSON.stringify({ type: 'goal', payload: { ...goalDraft, confidence: 1 }, source: 'manual' }),
      }) as ProfileGoal;
      setGoals(p => [created, ...p]);
      setGoalDraft({ title: '', description: '', category: '' });
      setShowGoalForm(false);
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  async function deleteGoal(id: string) {
    setBusyId(id);
    try {
      await coreFetch(`/agent/profile/goals/${id}`, { method: 'DELETE' });
      setGoals(p => p.filter(g => g.id !== id));
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  // ── Places ──────────────────────────────────────────────────────────────────

  const [showPlaceForm, setShowPlaceForm] = useState(false);
  const [placeDraft, setPlaceDraft] = useState({ label: '', address: '' });

  async function addPlace() {
    if (!placeDraft.label.trim()) return;
    setBusyId('new-place');
    try {
      const created = await coreFetch('/agent/profile/places', {
        method: 'POST',
        body: JSON.stringify(placeDraft),
      }) as KnownPlace;
      setPlaces(p => [created, ...p]);
      setPlaceDraft({ label: '', address: '' });
      setShowPlaceForm(false);
      showToast(true, 'Lugar guardado');
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  async function deletePlace(id: string) {
    setBusyId(id);
    try {
      await coreFetch(`/agent/profile/places/${id}`, { method: 'DELETE' });
      setPlaces(p => p.filter(x => x.id !== id));
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  // ── Relationships ───────────────────────────────────────────────────────────

  const [showRelForm, setShowRelForm] = useState(false);
  const [relDraft, setRelDraft] = useState({ display_name: '', relation: '' });

  async function addRelation() {
    if (!relDraft.display_name.trim() || !relDraft.relation.trim()) return;
    setBusyId('new-rel');
    try {
      const created = await coreFetch('/agent/profile/relationships', {
        method: 'POST',
        body: JSON.stringify(relDraft),
      }) as RelationshipEntry;
      setCtx(prev => {
        const existing = Array.isArray(prev.relationship_map) ? prev.relationship_map as RelationshipEntry[] : [];
        return { ...prev, relationship_map: [...existing, created] };
      });
      setRelDraft({ display_name: '', relation: '' });
      setShowRelForm(false);
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  async function deleteRelation(id: string) {
    setBusyId(id);
    try {
      await coreFetch(`/agent/profile/relationships/${id}`, { method: 'DELETE' });
      setCtx(prev => {
        const existing = Array.isArray(prev.relationship_map) ? prev.relationship_map as RelationshipEntry[] : [];
        return { ...prev, relationship_map: existing.filter(r => r.id !== id) };
      });
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  // ── Vault ───────────────────────────────────────────────────────────────────

  const [vaultDraft, setVaultDraft] = useState({ kind: 'card', label: '', value: '' });

  async function addVaultItem() {
    if (!vaultDraft.label.trim() || !vaultDraft.value.trim()) return;
    setBusyId('new-vault');
    try {
      const created = await coreFetch('/agent/profile/private-items', {
        method: 'POST',
        body: JSON.stringify(vaultDraft),
      }) as PrivateItem;
      setVault(p => [created, ...p]);
      setVaultDraft({ kind: 'card', label: '', value: '' });
      showToast(true, 'Guardado cifrado correctamente');
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  async function deleteVaultItem(id: string) {
    setBusyId(id);
    try {
      await coreFetch(`/agent/profile/private-items/${id}`, { method: 'DELETE' });
      setVault(p => p.filter(v => v.id !== id));
    } catch (e) { showToast(false, (e as Error).message); }
    finally { setBusyId(null); }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const startPct = timeToPercent(localStart);
  const endPct = timeToPercent(localEnd);
  const agePct = ((age - 16) / (85 - 16)) * 100;

  return (
    <ScrollArea className="h-full">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="mx-auto max-w-7xl p-5 pb-10">

        {/* ── Header stats ── */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: 'Pendientes', value: todos.filter(t => t.status !== 'done').length, color: 'text-amber-400' },
            { label: 'Metas activas', value: goals.filter(g => g.status === 'active').length, color: 'text-emerald-400' },
            { label: 'Lugares', value: places.length, color: 'text-sky-400' },
            { label: 'En bóveda', value: vault.length, color: 'text-rose-400' },
          ].map(s => (
            <div key={s.label} className="border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">{s.label}</p>
              <p className={cn('mt-1 text-2xl font-semibold tabular-nums', s.color)}>{s.value}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <main className="space-y-4">

            {/* ── Identidad ── */}
            <Card icon={UserRound} title="Mi identidad" accent="emerald">
              <div className="grid gap-3 sm:grid-cols-2">
                <InlineField label="Nombre completo" value={str(profile.full_name)} saved={savedId === 'personal_profile.full_name'} busy={busyId === 'personal_profile.full_name'} onSave={v => saveField('full_name', v, 'personal_profile')} />
                <InlineField label="Como quiero que me llamen" value={str(profile.preferred_address)} saved={savedId === 'personal_profile.preferred_address'} busy={busyId === 'personal_profile.preferred_address'} onSave={v => saveField('preferred_address', v, 'personal_profile')} />
                <InlineField label="Ocupación / trabajo" value={str(profile.occupation)} saved={savedId === 'personal_profile.occupation'} busy={busyId === 'personal_profile.occupation'} onSave={v => saveField('occupation', v, 'personal_profile')} />
                <InlineField label="Ciudad / ubicación" value={str(profile.current_location)} saved={savedId === 'personal_profile.current_location'} busy={busyId === 'personal_profile.current_location'} onSave={v => saveField('current_location', v, 'personal_profile')} />
              </div>

              {/* Age slider */}
              <div className="pt-1">
                <div className="mb-3 flex items-baseline justify-between">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">Edad</label>
                  <span className={cn('text-2xl font-semibold tabular-nums text-emerald-400 transition-all', savedId === 'personal_profile.age' && 'saved-flash')}>{age} <span className="text-sm font-normal text-zinc-500">años</span></span>
                </div>
                <input
                  type="range" min={16} max={85} step={1} value={age}
                  className="profile-slider"
                  style={{ background: `linear-gradient(to right,#10b981 0%,#10b981 ${agePct}%,#27272a ${agePct}%,#27272a 100%)` }}
                  onChange={e => setAge(Number(e.target.value))}
                  onMouseUp={() => saveField('age', String(age), 'personal_profile')}
                  onTouchEnd={() => saveField('age', String(age), 'personal_profile')}
                />
                <div className="mt-1 flex justify-between font-mono text-[9px] text-zinc-700">
                  {[16, 25, 35, 45, 55, 65, 75, 85].map(n => <span key={n}>{n}</span>)}
                </div>
              </div>
            </Card>

            {/* ── Horario ── */}
            <Card icon={CalendarDays} title="Mi horario" accent="emerald">

              {/* Day pills */}
              <div>
                <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-zinc-600">Días que trabajo</p>
                <div className="flex gap-2 flex-wrap">
                  {DAYS.map(d => (
                    <button
                      key={d.key}
                      title={d.full}
                      onClick={() => toggleDay(d.key)}
                      className={cn('day-pill anim-fade-in', days.includes(d.key) ? 'active' : 'inactive')}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-zinc-600">
                  {days.length === 0 ? 'Sin días seleccionados' : days.map(k => DAYS.find(d => d.key === k)?.full).filter(Boolean).join(' · ')}
                </p>
              </div>

              {/* Time range bar */}
              <div className="pt-1">
                <div className="mb-3 flex items-baseline justify-between">
                  <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">Horario de trabajo</p>
                  <span className={cn('font-mono text-xs text-emerald-400 transition-all', savedId === 'cowork_context.work_hours' && 'saved-flash')}>
                    {formatDuration(localStart, localEnd)}
                  </span>
                </div>

                {/* Visual bar */}
                <div className="time-bar">
                  <div className="time-bar-fill" style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }} />
                  <div className="time-bar-edge" style={{ left: `${startPct}%` }} />
                  <div className="time-bar-edge" style={{ left: `calc(${endPct}% - 3px)` }} />
                </div>

                {/* Hour labels */}
                <div className="mt-1.5 flex justify-between font-mono text-[9px] text-zinc-700">
                  {['0h', '3h', '6h', '9h', '12h', '15h', '18h', '21h', '24h'].map(h => <span key={h}>{h}</span>)}
                </div>

                {/* Time inputs */}
                <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-600">Entrada</label>
                    <input
                      type="time" value={localStart}
                      className="input-field font-mono text-sm"
                      onChange={e => setLocalStart(e.target.value)}
                      onBlur={commitTime}
                    />
                  </div>
                  <div className="mt-4 h-px w-6 bg-zinc-700" />
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-600">Salida</label>
                    <input
                      type="time" value={localEnd}
                      className="input-field font-mono text-sm"
                      onChange={e => setLocalEnd(e.target.value)}
                      onBlur={commitTime}
                    />
                  </div>
                </div>
              </div>

              {/* Routines / Communication */}
              <div className="grid gap-3 sm:grid-cols-2 pt-1">
                <InlineField label="Rutinas / hábitos" value={str(cowork.routines)} multiline saved={savedId === 'cowork_context.routines'} busy={busyId === 'cowork_context.routines'} onSave={v => saveField('routines', v, 'cowork_context')} />
                <InlineField label="Cómo prefiero comunicarme" value={str(cowork.communication_preferences)} saved={savedId === 'cowork_context.communication_preferences'} busy={busyId === 'cowork_context.communication_preferences'} onSave={v => saveField('communication_preferences', v, 'cowork_context')} />
              </div>
            </Card>

            {/* ── Gustos ── */}
            <Card icon={Heart} title="Mis gustos y preferencias" accent="rose">
              <TagField label="Me gusta" tags={likeTags} placeholder="Ej: música · viajes · café" onSave={tags => saveTagField(tags, 'likes', setLikeTags)} saved={savedId === 'personal_profile.likes'} />
              <TagField label="Hobbies" tags={hobbyTags} placeholder="Ej: surf · lectura · cocina" onSave={tags => saveTagField(tags, 'hobbies', setHobbyTags)} saved={savedId === 'personal_profile.hobbies'} />
              <div className="grid gap-3 sm:grid-cols-2">
                <InlineField label="Valores que me importan" value={str(profile.values)} multiline saved={savedId === 'personal_profile.values'} busy={busyId === 'personal_profile.values'} onSave={v => saveField('values', v, 'personal_profile')} />
                <InlineField label="Lo que NO me gusta" value={str(profile.dislikes)} saved={savedId === 'personal_profile.dislikes'} busy={busyId === 'personal_profile.dislikes'} onSave={v => saveField('dislikes', v, 'personal_profile')} />
              </div>
            </Card>

            {/* ── Lugares ── */}
            <Card icon={MapPin} title="Mis lugares" accent="sky" onAdd={() => setShowPlaceForm(p => !p)}>
              {showPlaceForm && (
                <div className="anim-slide-up grid gap-2 border border-zinc-800 bg-zinc-950/60 p-3 sm:grid-cols-[1fr_1fr_auto]">
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-600">Etiqueta</label>
                    <input value={placeDraft.label} onChange={e => setPlaceDraft(p => ({ ...p, label: e.target.value }))} placeholder="casa, trabajo, gym…" className="input-field" />
                  </div>
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-600">Dirección</label>
                    <input value={placeDraft.address} onChange={e => setPlaceDraft(p => ({ ...p, address: e.target.value }))} placeholder="Calle, colonia, ciudad" className="input-field" />
                  </div>
                  <div className="flex items-end gap-2">
                    <button onClick={addPlace} disabled={busyId === 'new-place'} className="flex h-9 items-center gap-1.5 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-300 transition-all hover:bg-emerald-500/20 disabled:opacity-50">
                      {busyId === 'new-place' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Guardar
                    </button>
                    <button onClick={() => setShowPlaceForm(false)} className="flex h-9 w-9 items-center justify-center rounded-sm border border-zinc-700 text-zinc-500 hover:text-zinc-300"><X className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
              )}
              {places.length === 0 && !showPlaceForm && <Empty text="EVA detecta tus lugares automáticamente, o agrégalos aquí." />}
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                {places.map(place => (
                  <div key={place.id} className="anim-slide-up group relative border border-zinc-800 bg-zinc-950/60 p-3 transition-colors hover:border-zinc-700">
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-sky-500/20 bg-sky-500/10">
                        <MapPin className="h-3.5 w-3.5 text-sky-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold capitalize text-zinc-100">{place.label}</p>
                        {place.address && <p className="mt-0.5 truncate text-[11px] text-zinc-500">{place.address}</p>}
                        {place.visit_count > 0 && <p className="mt-1 font-mono text-[10px] text-zinc-700">{place.visit_count} visitas</p>}
                      </div>
                    </div>
                    <BtnDel id={place.id} busy={busyId} onDelete={deletePlace} className="absolute right-2 top-2 opacity-0 group-hover:opacity-100" />
                  </div>
                ))}
              </div>
            </Card>

            {/* ── Metas + Pendientes ── */}
            <div className="grid gap-4 lg:grid-cols-2">

              <Card icon={Flag} title="Mis metas" accent="amber" onAdd={() => setShowGoalForm(p => !p)}>
                {showGoalForm && (
                  <div className="anim-slide-up space-y-2 border border-zinc-800 bg-zinc-950/60 p-3">
                    <input value={goalDraft.title} onChange={e => setGoalDraft(p => ({ ...p, title: e.target.value }))} placeholder="¿Qué quieres lograr?" className="input-field" />
                    <input value={goalDraft.description} onChange={e => setGoalDraft(p => ({ ...p, description: e.target.value }))} placeholder="Descripción (opcional)" className="input-field" />
                    <select value={goalDraft.category} onChange={e => setGoalDraft(p => ({ ...p, category: e.target.value }))} className="select-field">
                      <option value="">Categoría…</option>
                      {['salud', 'trabajo', 'finanzas', 'familia', 'educación', 'personal', 'otro'].map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <div className="flex gap-2">
                      <Btn onClick={addGoal} busy={busyId === 'new-goal'} label="Guardar meta" accent />
                      <Btn onClick={() => setShowGoalForm(false)} label="" icon={<X className="h-3.5 w-3.5" />} />
                    </div>
                  </div>
                )}
                {goals.length === 0 && !showGoalForm && <Empty text="Sin metas. Agrégalas con el botón +" />}
                <div className="space-y-2">
                  {goals.map(g => (
                    <div key={g.id} className="anim-slide-up group relative border border-zinc-800 bg-zinc-950/60 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-zinc-100">{safeStr(g.title, g)}</p>
                          {g.category && <span className="font-mono text-[10px] text-amber-400/70">{g.category}</span>}
                        </div>
                        <BtnDel id={g.id} busy={busyId} onDelete={deleteGoal} className="opacity-0 group-hover:opacity-100" />
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div className="h-full rounded-full bg-amber-500/50 transition-all" style={{ width: `${g.progress}%` }} />
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-zinc-600">{g.status} · {g.progress}%</p>
                    </div>
                  ))}
                </div>
              </Card>

              <Card icon={CheckCircle2} title="Pendientes" accent="emerald" onAdd={() => setShowTodoForm(p => !p)}>
                {showTodoForm && (
                  <div className="anim-slide-up space-y-2 border border-zinc-800 bg-zinc-950/60 p-3">
                    <input value={todoDraft.title} onChange={e => setTodoDraft(p => ({ ...p, title: e.target.value }))} onKeyDown={e => e.key === 'Enter' && addTodo()} placeholder="¿Qué tienes pendiente?" className="input-field" autoFocus />
                    <div className="flex items-center gap-3">
                      <label className="font-mono text-[10px] uppercase text-zinc-600">Prioridad</label>
                      <div className="flex gap-1">
                        {[
                          { v: '3', label: 'Alta', color: 'border-red-500/50 text-red-400 bg-red-500/10' },
                          { v: '2', label: 'Media', color: 'border-amber-500/50 text-amber-400 bg-amber-500/10' },
                          { v: '1', label: 'Baja', color: 'border-zinc-600 text-zinc-400 bg-zinc-800/50' },
                        ].map(p => (
                          <button key={p.v} onClick={() => setTodoDraft(d => ({ ...d, priority: p.v }))}
                            className={cn('rounded-sm border px-2 py-0.5 text-[10px] font-mono transition-all', todoDraft.priority === p.v ? p.color : 'border-zinc-700 text-zinc-600 hover:border-zinc-600')}>
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Btn onClick={addTodo} busy={busyId === 'new-todo'} label="Guardar" accent />
                      <Btn onClick={() => setShowTodoForm(false)} label="" icon={<X className="h-3.5 w-3.5" />} />
                    </div>
                  </div>
                )}
                {todos.length === 0 && !showTodoForm && <Empty text="Sin pendientes. Agrégalos con el botón +" />}
                <div className="space-y-1.5">
                  {todos.map(t => (
                    <div key={t.id} className="anim-slide-up group flex items-start gap-2.5 rounded-sm border border-transparent px-2 py-2 transition-colors hover:border-zinc-800 hover:bg-zinc-950/40">
                      <div className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm border transition-colors', t.status === 'done' ? 'border-emerald-500 bg-emerald-500/20' : 'border-zinc-600')} />
                      <div className="min-w-0 flex-1">
                        <p className={cn('text-xs text-zinc-200', t.status === 'done' && 'line-through text-zinc-500')}>{safeStr(t.title, t)}</p>
                        {t.notes && <p className="mt-0.5 text-[11px] text-zinc-600">{t.notes}</p>}
                      </div>
                      <span className={cn('shrink-0 font-mono text-[10px]', t.priority >= 3 ? 'text-red-400' : t.priority === 2 ? 'text-amber-400' : 'text-zinc-600')}>P{t.priority}</span>
                      <BtnDel id={t.id} busy={busyId} onDelete={deleteTodo} className="opacity-0 group-hover:opacity-100" />
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            {/* ── Notas ── */}
            <Card icon={StickyNote} title="Notas" accent="violet" onAdd={() => setShowNoteForm(p => !p)}>
              {showNoteForm && (
                <div className="anim-slide-up space-y-2 border border-zinc-800 bg-zinc-950/60 p-3">
                  <input value={noteDraft.title} onChange={e => setNoteDraft(p => ({ ...p, title: e.target.value }))} placeholder="Título (opcional)" className="input-field" />
                  <textarea value={noteDraft.content} onChange={e => setNoteDraft(p => ({ ...p, content: e.target.value }))} rows={3} placeholder="Contenido de la nota" className="input-field resize-none" />
                  <div className="flex gap-2">
                    <Btn onClick={addNote} busy={busyId === 'new-note'} label="Guardar nota" accent />
                    <Btn onClick={() => setShowNoteForm(false)} label="" icon={<X className="h-3.5 w-3.5" />} />
                  </div>
                </div>
              )}
              {notes.length === 0 && !showNoteForm && <Empty text="Sin notas. Agrégalas con el botón +" />}
              <div className="grid gap-2 sm:grid-cols-2">
                {notes.map(n => (
                  <div key={n.id} className="anim-slide-up group relative border-l-2 border-violet-500/40 bg-violet-500/5 p-3 pl-3">
                    {n.title && <p className="mb-1 text-xs font-medium text-zinc-200">{n.title}</p>}
                    <p className="text-[11px] leading-relaxed text-zinc-400">{safeStr(n.content, n)}</p>
                    <BtnDel id={n.id} busy={busyId} onDelete={deleteNote} className="absolute right-2 top-2 opacity-0 group-hover:opacity-100" />
                  </div>
                ))}
              </div>
            </Card>

          </main>

          {/* ── Aside ── */}
          <aside className="space-y-4">

            {/* Agenda */}
            <Card icon={CalendarDays} title="Próximos eventos" accent="sky">
              {scheduleEvents.length === 0 && <Empty text="Sin eventos próximos." />}
              <div className="space-y-2">
                {scheduleEvents.map(ev => (
                  <div key={ev.id} className="border-l-2 border-sky-500/30 bg-sky-500/5 p-2.5 pl-3">
                    <p className="text-xs font-medium text-zinc-200">{ev.title}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-sky-400/70">
                      {[ev.scheduled_date, ev.scheduled_time].filter(Boolean).join(' · ')}
                    </p>
                    {ev.location_label && <p className="mt-0.5 text-[11px] text-zinc-600">{ev.location_label}</p>}
                  </div>
                ))}
              </div>
            </Card>

            {/* Relaciones — sensible */}
            <Card icon={Users} title="Familiares y contactos" accent="amber" sensitive onAdd={() => setShowRelForm(p => !p)}>
              <SensitiveNotice text="Solo puedes agregar o eliminar — no se muestran detalles." />
              {showRelForm && (
                <div className="anim-slide-up space-y-2 border border-amber-500/20 bg-amber-500/5 p-3">
                  <input value={relDraft.display_name} onChange={e => setRelDraft(p => ({ ...p, display_name: e.target.value }))} placeholder="Nombre" className="input-field" />
                  <input value={relDraft.relation} onChange={e => setRelDraft(p => ({ ...p, relation: e.target.value }))} placeholder="Relación (ej: hermana, madre)" className="input-field" />
                  <div className="flex gap-2">
                    <Btn onClick={addRelation} busy={busyId === 'new-rel'} label="Agregar" accent amber />
                    <Btn onClick={() => setShowRelForm(false)} label="" icon={<X className="h-3.5 w-3.5" />} />
                  </div>
                </div>
              )}
              {relations.length === 0 && !showRelForm && <Empty text="Sin relaciones mapeadas." />}
              <div className="space-y-2">
                {relations.map(r => (
                  <div key={r.id} className="anim-slide-up group flex items-center justify-between gap-2 border border-amber-500/15 bg-amber-500/5 p-2.5">
                    <div>
                      <p className="text-xs font-medium text-amber-100">{r.display_name}</p>
                      <p className="font-mono text-[10px] uppercase tracking-wider text-amber-400/60">{r.relation}</p>
                    </div>
                    <BtnDel id={r.id} busy={busyId} onDelete={deleteRelation} amber className="opacity-0 group-hover:opacity-100" />
                  </div>
                ))}
              </div>
            </Card>

            {/* Bóveda — sensible */}
            <Card icon={LockKeyhole} title="Bóveda privada" accent="rose" sensitive>
              <SensitiveNotice text="Todo se cifra con AES-256. EVA puede leerlo, tú solo agregas o eliminas." />
              <div className="space-y-2">
                <select value={vaultDraft.kind} onChange={e => setVaultDraft(p => ({ ...p, kind: e.target.value }))} className="select-field">
                  {VAULT_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
                <input value={vaultDraft.label} onChange={e => setVaultDraft(p => ({ ...p, label: e.target.value }))} placeholder="Etiqueta (ej: Visa …1234, pasaporte)" className="input-field" />
                <textarea value={vaultDraft.value} onChange={e => setVaultDraft(p => ({ ...p, value: e.target.value }))} rows={3} placeholder="Dato privado — solo EVA accede a esto" className="input-field resize-none" />
                <Btn onClick={addVaultItem} busy={busyId === 'new-vault'} label="Guardar cifrado" icon={<KeyRound className="h-3.5 w-3.5" />} accent amber full />
              </div>

              <div className="space-y-1.5 pt-1">
                {vault.length === 0 && <Empty text="Sin datos privados cifrados." />}
                {vault.map(item => (
                  <div key={item.id} className="anim-slide-up group flex items-start justify-between gap-2 border border-rose-500/15 bg-rose-500/5 p-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-rose-100">{item.label}</p>
                      <p className="font-mono text-[10px] text-rose-300/60">{item.hint}</p>
                      <span className="font-mono text-[9px] text-rose-400/40">{item.kind}</span>
                    </div>
                    <BtnDel id={item.id} busy={busyId} onDelete={deleteVaultItem} amber className="opacity-0 group-hover:opacity-100" />
                  </div>
                ))}
              </div>
            </Card>

            {/* Privacidad */}
            <Card icon={Shield} title="Privacidad" accent="zinc">
              <ul className="space-y-1.5 text-[11px] leading-relaxed text-zinc-500">
                <li>La bóveda cifra cada dato con AES-256-GCM. El dashboard nunca lo muestra.</li>
                <li>Las relaciones y contactos tampoco son visibles — solo puedes agregar y eliminar.</li>
                <li>Los lugares los detecta EVA automáticamente o los puedes agregar manualmente.</li>
              </ul>
            </Card>

          </aside>
        </div>
      </div>

      {/* ── Toast ── */}
      {toast && (
        <div className={cn(
          'fixed bottom-5 right-5 z-50 anim-slide-up flex items-center gap-2 rounded-sm border px-4 py-2.5 font-mono text-xs shadow-xl',
          toast.ok ? 'border-emerald-500/30 bg-zinc-950 text-emerald-400' : 'border-red-500/30 bg-zinc-950 text-red-400',
        )}>
          {toast.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {toast.text}
        </div>
      )}
    </ScrollArea>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Card({ icon: Icon, title, accent, sensitive, onAdd, children }: {
  icon: typeof UserRound; title: string; accent: string;
  sensitive?: boolean; onAdd?: () => void; children: React.ReactNode;
}) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-400 border-emerald-500/20',
    amber: 'text-amber-400 border-amber-500/20',
    rose: 'text-rose-400 border-rose-500/20',
    sky: 'text-sky-400 border-sky-500/20',
    violet: 'text-violet-400 border-violet-500/20',
    zinc: 'text-zinc-500 border-zinc-700',
  };
  const cls = colors[accent] ?? colors.zinc;
  return (
    <section className={cn('rounded-sm border bg-zinc-950/40 p-4', cls.split(' ')[1])}>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={cn('h-4 w-4', cls.split(' ')[0])} />
          <h3 className="text-sm font-medium text-zinc-100">{title}</h3>
          {sensitive && <span className="rounded-sm bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-amber-400/70">sensible</span>}
        </div>
        {onAdd && (
          <button onClick={onAdd} className={cn('flex h-6 w-6 items-center justify-center rounded-sm border transition-all hover:scale-110', cls.split(' ')[1], cls.split(' ')[0])} aria-label="Agregar">
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function InlineField({ label, value, onSave, busy, saved, multiline }: {
  label: string; value: string; onSave: (v: string) => void;
  busy?: boolean; saved?: boolean; multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  function start() { setDraft(value); setEditing(true); setTimeout(() => ref.current?.focus(), 0); }
  function save() { if (draft.trim() !== value) onSave(draft.trim()); setEditing(false); }

  const sharedProps = {
    ref, value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: save,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !multiline) save(); if (e.key === 'Escape') setEditing(false); },
    className: 'w-full bg-transparent text-xs text-zinc-100 outline-none border-b border-emerald-400/40 pb-0.5 resize-none',
    rows: multiline ? 2 : undefined,
  };

  return (
    <div className="group cursor-pointer rounded-sm border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 transition-colors hover:border-zinc-700" onClick={!editing ? start : undefined}>
      <p className={cn('font-mono text-[10px] uppercase tracking-wider transition-colors', saved ? 'saved-flash text-emerald-400' : 'text-zinc-600')}>{label}{saved ? ' ✓' : ''}</p>
      <div className="mt-1">
        {editing ? (
          multiline ? <textarea {...sharedProps as React.TextareaHTMLAttributes<HTMLTextAreaElement>} /> : <input {...sharedProps as React.InputHTMLAttributes<HTMLInputElement>} />
        ) : (
          <p className={cn('text-xs leading-relaxed', value ? 'text-zinc-200' : 'text-zinc-600 italic')}>{value || 'Toca para editar…'}</p>
        )}
      </div>
      {busy && <Loader2 className="mt-1 h-3 w-3 animate-spin text-emerald-400" />}
    </div>
  );
}

function TagField({ label, tags, onSave, placeholder, saved }: {
  label: string; tags: string[]; onSave: (t: string[]) => void;
  placeholder?: string; saved?: boolean;
}) {
  const [localTags, setLocalTags] = useState(tags);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function add() {
    const trimmed = input.trim().replace(/,$/, '');
    if (!trimmed || localTags.includes(trimmed)) { setInput(''); return; }
    const next = [...localTags, trimmed];
    setLocalTags(next);
    setInput('');
    onSave(next);
  }

  function remove(tag: string) {
    const next = localTags.filter(t => t !== tag);
    setLocalTags(next);
    onSave(next);
  }

  return (
    <div>
      <p className={cn('mb-2 font-mono text-[10px] uppercase tracking-wider', saved ? 'saved-flash text-emerald-400' : 'text-zinc-600')}>{label}{saved ? ' ✓' : ''}</p>
      <div
        className="flex min-h-[38px] cursor-text flex-wrap gap-1.5 rounded-sm border border-zinc-700 bg-zinc-900/40 px-2 py-1.5 transition-colors focus-within:border-emerald-400/40"
        onClick={() => inputRef.current?.focus()}
      >
        {localTags.map(tag => (
          <span key={tag} className="tag-chip anim-fade-in">
            {tag}
            <button type="button" onClick={e => { e.stopPropagation(); remove(tag); }} className="text-zinc-500 hover:text-rose-400 transition-colors">
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
          onBlur={() => { if (input.trim()) add(); }}
          placeholder={localTags.length === 0 ? (placeholder ?? 'Escribe y presiona Enter…') : '+'}
          className="min-w-16 flex-1 bg-transparent text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600"
        />
      </div>
    </div>
  );
}

function BtnDel({ id, busy, onDelete, amber, className }: {
  id: string; busy: string | null; onDelete: (id: string) => void;
  amber?: boolean; className?: string;
}) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onDelete(id); }}
      disabled={busy === id}
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border transition-all',
        amber
          ? 'border-amber-500/20 text-amber-300/40 hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400'
          : 'border-zinc-700 text-zinc-600 hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400',
        className,
      )}
      aria-label="Eliminar"
    >
      {busy === id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
    </button>
  );
}

function Btn({ onClick, busy, label, icon, accent, amber, full }: {
  onClick: () => void; busy?: boolean; label: string;
  icon?: React.ReactNode; accent?: boolean; amber?: boolean; full?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'flex h-8 items-center gap-1.5 rounded-sm border px-3 text-xs font-medium transition-all active:scale-95 disabled:opacity-50',
        full && 'w-full justify-center',
        accent && amber && 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20',
        accent && !amber && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20',
        !accent && 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200',
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {label}
    </button>
  );
}

function SensitiveNotice({ text }: { text: string }) {
  return <p className="rounded-sm border border-amber-500/10 bg-amber-500/5 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-400/60">{text}</p>;
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-sm border border-dashed border-zinc-800 px-3 py-3 text-[11px] text-zinc-600">{text}</p>;
}

function safeStr(value: string | null, item: { sensitivity: string; sensitive_hint: string | null }) {
  return item.sensitivity === 'sensitive' ? (item.sensitive_hint ?? 'Dato privado') : (value ?? '');
}
