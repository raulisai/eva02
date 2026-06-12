'use client';

import { useState } from 'react';
import {
  Bot, BriefcaseBusiness, CheckCircle2, KeyRound, Loader2, LockKeyhole,
  Plus, Save, Shield, Sparkles, Trash2, UserRound, Users, XCircle,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { coreFetch } from '@/lib/core-api';
import type { AgentSoul } from '@/lib/types';

const AUTONOMY_LEVELS = [
  { level: 0 as const, name: 'Observer',        blurb: 'Every action requires explicit approval.' },
  { level: 1 as const, name: 'Assisted',        blurb: 'Sensitive actions (L1+) require approval.' },
  { level: 2 as const, name: 'Semi-autonomous', blurb: 'Only money / production / data actions (L2+) require approval.' },
  { level: 3 as const, name: 'Autonomous',      blurb: 'Only critical L3 actions require dual approval.' },
];

interface SoulEditorProps {
  orgId: string;
  initialSoul: AgentSoul | null;
}

const PROFILE_FIELDS = [
  { key: 'full_name', label: 'Nombre', placeholder: 'Tu nombre completo' },
  { key: 'preferred_address', label: 'Como debe llamarte', placeholder: 'Ej. Diego, jefe, amo, doctor' },
  { key: 'age', label: 'Edad', placeholder: 'Ej. 34' },
  { key: 'current_location', label: 'Ubicacion actual', placeholder: 'Ej. Ciudad de Mexico, Roma Norte' },
  { key: 'address', label: 'Direccion', placeholder: 'Direccion habitual' },
  { key: 'workplace', label: 'Lugar de trabajo', placeholder: 'Empresa, zona o direccion laboral' },
  { key: 'likes', label: 'Gustos', placeholder: 'Comida, hobbies, preferencias' },
  { key: 'dislikes', label: 'No me gusta', placeholder: 'Cosas a evitar' },
  { key: 'allergies', label: 'Alergias', placeholder: 'Alergias o restricciones medicas' },
  { key: 'weight', label: 'Peso', placeholder: 'Ej. 78 kg' },
  { key: 'height', label: 'Altura', placeholder: 'Ej. 1.78 m' },
] as const;

type ProfileKey = typeof PROFILE_FIELDS[number]['key'];
type PersonalProfile = Record<ProfileKey, string>;

const COWORK_FIELDS = [
  { key: 'calendars', label: 'Calendarios', placeholder: 'Calendarios conectados, cuentas, reglas de uso' },
  { key: 'upcoming_appointments', label: 'Proximas citas', placeholder: 'Citas importantes, medicos, reuniones, viajes' },
  { key: 'pending_tasks', label: 'Tareas pendientes', placeholder: 'Pendientes personales y laborales que EVA debe recordar' },
  { key: 'work_hours', label: 'Horarios de trabajo', placeholder: 'Ej. Lun-vie 9:00-18:00, bloques de enfoque' },
  { key: 'days_off', label: 'Dias libres', placeholder: 'Fines de semana, vacaciones, dias que no quieres agendar' },
  { key: 'goals', label: 'Metas', placeholder: 'Metas de salud, trabajo, dinero, aprendizaje, proyectos' },
  { key: 'family', label: 'Familia y relaciones', placeholder: 'Personas importantes, cumpleaños, responsabilidades' },
  { key: 'social_media', label: 'Redes sociales', placeholder: 'Usuarios, plataformas, estilo, limites y cuentas relevantes' },
  { key: 'projects', label: 'Proyectos activos', placeholder: 'Proyectos donde EVA puede ayudarte como coworker' },
  { key: 'routines', label: 'Rutinas', placeholder: 'Rutina diaria/semanal, habitos, horarios preferidos' },
  { key: 'communication_preferences', label: 'Comunicacion', placeholder: 'Como quieres recordatorios, resumenes, tono y frecuencia' },
  { key: 'important_links', label: 'Links importantes', placeholder: 'URLs de docs, tableros, perfiles, calendarios publicos' },
] as const;

type CoworkKey = typeof COWORK_FIELDS[number]['key'];
type CoworkContext = Record<CoworkKey, string>;
type EditorSection = 'agent' | 'user' | 'private';

const SECTIONS = [
  { id: 'agent' as const, label: 'Agente EVA', icon: Bot },
  { id: 'user' as const, label: 'Mi perfil', icon: UserRound },
  { id: 'private' as const, label: 'Privado', icon: LockKeyhole },
];

const PRIVATE_FIELDS = [
  { key: 'sensitive_identity', label: 'Identidad sensible', placeholder: 'Datos que EVA puede usar pero no debe mostrar ni repetir sin permiso.' },
  { key: 'family_private', label: 'Familia privada', placeholder: 'Contexto familiar delicado, excepciones, nombres reales, responsabilidades.' },
  { key: 'accounts_private', label: 'Cuentas y accesos', placeholder: 'Hints operativos, nunca secretos crudos ni passwords.' },
  { key: 'assistant_boundaries', label: 'Reglas privadas', placeholder: 'Limites, preferencias y reglas que EVA debe aplicar en silencio.' },
] as const;

type PrivateKey = typeof PRIVATE_FIELDS[number]['key'];
type PrivateDraft = Record<PrivateKey, string>;

interface RelationshipEntry {
  id: string;
  display_name: string;
  relation: string;
  aliases: string;
  contact_hint: string;
  notes: string;
}

function recordFromFields<T extends readonly { key: string }[]>(
  fields: T,
  source: Record<string, unknown>,
) {
  return Object.fromEntries(fields.map(({ key }) => [key, String(source[key] ?? '')]));
}

function relationFromUnknown(value: unknown): RelationshipEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const aliases = Array.isArray(item.aliases) ? item.aliases.map(String).join(', ') : String(item.aliases ?? '');
    return {
      id: String(item.id ?? `relationship-${index}`),
      display_name: String(item.display_name ?? ''),
      relation: String(item.relation ?? ''),
      aliases,
      contact_hint: String(item.contact_hint ?? ''),
      notes: String(item.notes ?? ''),
    };
  });
}

export function SoulEditor({ orgId, initialSoul }: SoulEditorProps) {
  const personaContext = (initialSoul?.persona_context ?? {}) as Record<string, unknown>;
  const legacyPrefs = initialSoul?.model_prefs ?? {};
  const initialProfile = (personaContext.personal_profile ?? legacyPrefs['personal_profile'] ?? {}) as Partial<PersonalProfile>;
  const initialCowork = (personaContext.cowork_context ?? legacyPrefs['cowork_context'] ?? {}) as Partial<CoworkContext>;
  const [name, setName] = useState(initialSoul?.name ?? 'EVA');
  const [persona, setPersona] = useState(initialSoul?.persona ?? '');
  const [profile, setProfile] = useState<PersonalProfile>(() => recordFromFields(PROFILE_FIELDS, initialProfile) as PersonalProfile);
  const [cowork, setCowork] = useState<CoworkContext>(() => recordFromFields(COWORK_FIELDS, initialCowork) as CoworkContext);
  const [expectations, setExpectations] = useState(String(personaContext.expectations ?? ''));
  const [relationships, setRelationships] = useState<RelationshipEntry[]>(() => relationFromUnknown(personaContext.relationship_map));
  const [section, setSection] = useState<EditorSection>('agent');
  const [privateDraft, setPrivateDraft] = useState<PrivateDraft>(() => Object.fromEntries(
    PRIVATE_FIELDS.map(({ key }) => [key, '']),
  ) as PrivateDraft);
  const [directivesText, setDirectivesText] = useState(
    Array.isArray(initialSoul?.directives) ? (initialSoul!.directives as string[]).join('\n') : '',
  );
  const [autonomy, setAutonomy] = useState<0 | 1 | 2 | 3>(initialSoul?.autonomy_level ?? 1);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setFeedback(null);
    try {
      const supabase = createClient();
      const directives = directivesText.split('\n').map((line) => line.trim()).filter(Boolean);
      const relationship_map = relationships
        .map((entry) => ({
          id: entry.id,
          display_name: entry.display_name.trim(),
          relation: entry.relation.trim(),
          aliases: entry.aliases.split(',').map((alias) => alias.trim()).filter(Boolean),
          contact_hint: entry.contact_hint.trim(),
          notes: entry.notes.trim(),
        }))
        .filter((entry) => entry.display_name || entry.relation);
      const persona_context = {
        ...personaContext,
        expectations,
        communication_preferences: cowork.communication_preferences,
        routines: cowork.routines,
        family: cowork.family,
        projects: cowork.projects,
        social_media: cowork.social_media,
        work_hours: cowork.work_hours,
        days_off: cowork.days_off,
        important_links: cowork.important_links,
        personal_profile: profile,
        cowork_context: cowork,
        relationship_map,
      };
      const { error } = await supabase
        .from('agent_souls')
        .upsert({
          org_id: orgId,
          name,
          persona,
          directives,
          autonomy_level: autonomy,
          persona_context,
        }, { onConflict: 'org_id' });
      if (error) throw error;
      const privateContext = PRIVATE_FIELDS
        .map(({ key, label }) => privateDraft[key].trim() ? `## ${label}\n${privateDraft[key].trim()}` : '')
        .filter(Boolean)
        .join('\n\n');
      if (privateContext) {
        await coreFetch('/agent/soul/private-context', {
          method: 'POST',
          body: JSON.stringify({ text: privateContext }),
        });
        setPrivateDraft(Object.fromEntries(PRIVATE_FIELDS.map(({ key }) => [key, ''])) as PrivateDraft);
      }
      setFeedback({ ok: true, text: 'Soul updated' });
    } catch (error) {
      setFeedback({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-6xl p-6">
        <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="space-y-3 border-r border-zinc-800 pr-4">
            <div className="space-y-1">
              <p className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Soul workspace</p>
              <h2 className="text-sm font-semibold text-zinc-100">Separacion de identidad</h2>
            </div>
            <div className="space-y-1" role="tablist" aria-label="Soul editor sections">
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={section === id}
                  onClick={() => setSection(id)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-sm border px-3 py-2 text-left text-xs transition-colors',
                    section === id
                      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
                      : 'border-transparent text-zinc-500 hover:border-zinc-800 hover:bg-zinc-900/60 hover:text-zinc-200',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </span>
                  {id === 'private' && initialSoul?.private_context_hint && (
                    <Shield className="h-3.5 w-3.5 text-amber-300" />
                  )}
                </button>
              ))}
            </div>
            <div className="rounded-sm border border-zinc-800 bg-zinc-950/80 p-3">
              <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                <KeyRound className="h-3.5 w-3.5 text-amber-300" />
                Private context
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                {initialSoul?.private_context_hint ?? 'Sin datos privados cifrados'}
              </p>
            </div>
          </aside>

          <div className="min-w-0 space-y-6">
            {section === 'agent' && (
              <section className="space-y-6" aria-labelledby="agent-section-title">
                <SectionHeader
                  id="agent-section-title"
                  icon={Sparkles}
                  title="Agente EVA"
                  eyebrow="Identidad del agente"
                  detail="Nombre, personalidad, reglas permanentes y autonomia pertenecen a EVA, no al usuario."
                />

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
                  <div className="space-y-4">
                    <label className="block space-y-1" htmlFor="soul-name">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Nombre del agente</span>
                      <input
                        id="soul-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500/60"
                      />
                    </label>

                    <label className="block space-y-1" htmlFor="soul-persona">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Personalidad y comportamiento</span>
                      <textarea
                        id="soul-persona"
                        value={persona}
                        onChange={(event) => setPersona(event.target.value)}
                        rows={9}
                        placeholder="EVA es mi agente personal. Es directa, cuidadosa, leal a mis preferencias, security-first y siempre intenta resolver antes de rendirse..."
                        className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 resize-y"
                      />
                    </label>

                    <label className="block space-y-1" htmlFor="soul-directives">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Directivas permanentes</span>
                      <textarea
                        id="soul-directives"
                        value={directivesText}
                        onChange={(event) => setDirectivesText(event.target.value)}
                        rows={6}
                        placeholder={'Never spend money without approval\nAlways answer in Spanish'}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 resize-y"
                      />
                    </label>
                  </div>

                  <div className="space-y-3">
                    <span className="block text-[10px] font-mono uppercase tracking-wider text-zinc-500">Autonomia</span>
                    <div className="grid gap-2" role="radiogroup" aria-label="Autonomy level">
                      {AUTONOMY_LEVELS.map(({ level, name: levelName, blurb }) => (
                        <button
                          key={level}
                          type="button"
                          role="radio"
                          aria-checked={autonomy === level}
                          onClick={() => setAutonomy(level)}
                          className={cn(
                            'border rounded-sm px-3 py-2 text-left transition-all',
                            autonomy === level
                              ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-200'
                              : 'border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300',
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium">{levelName}</span>
                            <span className="font-mono text-xs">L{level}</span>
                          </div>
                          <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">{blurb}</p>
                        </button>
                      ))}
                    </div>
                    <p className="border-l border-amber-400/40 pl-3 text-[11px] font-mono leading-relaxed text-amber-300/80">
                      Money, production and data actions still use the Approval Engine.
                    </p>
                  </div>
                </div>
              </section>
            )}

            {section === 'user' && (
              <section className="space-y-6" aria-labelledby="user-section-title">
                <SectionHeader
                  id="user-section-title"
                  icon={UserRound}
                  title="Mi perfil"
                  eyebrow="Informacion del usuario"
                  detail="Datos sobre ti, tus relaciones, trabajo, agenda y preferencias. EVA lo usa como contexto, sin asumir que es su identidad."
                />

                <div className="grid gap-4 xl:grid-cols-2">
                  <FieldGroup icon={UserRound} title="Datos personales">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {PROFILE_FIELDS.map(({ key, label, placeholder }) => (
                        <label key={key} className="space-y-1">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">{label}</span>
                          <input
                            value={profile[key]}
                            onChange={(event) => setProfile((prev) => ({ ...prev, [key]: event.target.value }))}
                            placeholder={placeholder}
                            className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
                          />
                        </label>
                      ))}
                    </div>
                  </FieldGroup>

                  <FieldGroup icon={BriefcaseBusiness} title="Contexto operativo">
                    <div className="grid gap-2">
                      {COWORK_FIELDS.map(({ key, label, placeholder }) => (
                        <label key={key} className="space-y-1">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">{label}</span>
                          <textarea
                            value={cowork[key]}
                            onChange={(event) => setCowork((prev) => ({ ...prev, [key]: event.target.value }))}
                            placeholder={placeholder}
                            rows={2}
                            className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 resize-y"
                          />
                        </label>
                      ))}
                    </div>
                  </FieldGroup>
                </div>

                <FieldGroup icon={Sparkles} title="Que espero de EVA">
                  <textarea
                    id="user-expectations"
                    value={expectations}
                    onChange={(event) => setExpectations(event.target.value)}
                    rows={4}
                    placeholder="Ej. Que sea proactiva, recuerde contexto familiar, resuelva primero y solo pregunte cuando falte informacion critica."
                    className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 resize-y"
                  />
                </FieldGroup>

                <FieldGroup
                  icon={Users}
                  title="Mapa de familiares y contactos"
                  action={(
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setRelationships((prev) => [...prev, {
                        id: crypto.randomUUID(),
                        display_name: '',
                        relation: '',
                        aliases: '',
                        contact_hint: '',
                        notes: '',
                      }])}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add
                    </Button>
                  )}
                >
                  <div className="space-y-2">
                    {relationships.length === 0 && (
                      <div className="border border-dashed border-zinc-800 px-3 py-4 text-xs text-zinc-500">
                        Agrega personas como mama, papa, pareja, jefe o cualquier contacto importante.
                      </div>
                    )}
                    {relationships.map((entry, index) => (
                      <div key={entry.id} className="grid gap-2 border border-zinc-800 rounded-sm p-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                        <input
                          value={entry.display_name}
                          onChange={(event) => setRelationships((prev) => prev.map((item, i) => i === index ? { ...item, display_name: event.target.value } : item))}
                          placeholder="Nombre en contactos"
                          className="bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
                        />
                        <input
                          value={entry.relation}
                          onChange={(event) => setRelationships((prev) => prev.map((item, i) => i === index ? { ...item, relation: event.target.value } : item))}
                          placeholder="Relacion: mama"
                          className="bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
                        />
                        <input
                          value={entry.aliases}
                          onChange={(event) => setRelationships((prev) => prev.map((item, i) => i === index ? { ...item, aliases: event.target.value } : item))}
                          placeholder="Aliases: mamá, madre"
                          className="bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
                        />
                        <button
                          type="button"
                          aria-label="Remove relationship"
                          onClick={() => setRelationships((prev) => prev.filter((_, i) => i !== index))}
                          className="h-8 w-8 inline-flex items-center justify-center border border-zinc-700 rounded-sm text-zinc-500 hover:text-red-300 hover:border-red-500/50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <input
                          value={entry.contact_hint}
                          onChange={(event) => setRelationships((prev) => prev.map((item, i) => i === index ? { ...item, contact_hint: event.target.value } : item))}
                          placeholder="Hint del contacto: WhatsApp, telefono, cuenta"
                          className="md:col-span-2 bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
                        />
                        <input
                          value={entry.notes}
                          onChange={(event) => setRelationships((prev) => prev.map((item, i) => i === index ? { ...item, notes: event.target.value } : item))}
                          placeholder="Notas utiles"
                          className="bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
                        />
                      </div>
                    ))}
                  </div>
                </FieldGroup>
              </section>
            )}

            {section === 'private' && (
              <section className="space-y-6" aria-labelledby="private-section-title">
                <SectionHeader
                  id="private-section-title"
                  icon={LockKeyhole}
                  title="Privado"
                  eyebrow="Contexto cifrado"
                  detail="Esta informacion se envia a eva-core, se cifra con AES-256-GCM y no vuelve al navegador en texto plano."
                  accent="amber"
                />

                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="pending">
                    <Shield className="h-3 w-3" />
                    {initialSoul?.private_context_hint ?? 'vault empty'}
                  </Badge>
                  <Badge variant="default">server-side decrypt</Badge>
                  <Badge variant="default">model-only prompt</Badge>
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  {PRIVATE_FIELDS.map(({ key, label, placeholder }) => (
                    <label key={key} className="space-y-1 rounded-sm border border-zinc-800 bg-zinc-950/70 p-3">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-amber-300/80">{label}</span>
                      <textarea
                        value={privateDraft[key]}
                        onChange={(event) => setPrivateDraft((prev) => ({ ...prev, [key]: event.target.value }))}
                        rows={5}
                        placeholder={placeholder}
                        className="mt-2 w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/60 resize-y"
                      />
                    </label>
                  ))}
                </div>

                <div className="border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] font-mono leading-relaxed text-amber-200/80">
                  Al guardar, estos campos se cifran y se limpian de la interfaz. Para reemplazar el vault, escribe el nuevo contexto privado y vuelve a guardar.
                </div>
              </section>
            )}

            {feedback && (
              <div className={cn(
                'flex items-center gap-2 text-xs font-mono rounded-sm border px-3 py-2',
                feedback.ok ? 'border-emerald-500/30 text-emerald-400' : 'border-red-500/30 text-red-400',
              )}>
                {feedback.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                {feedback.text}
              </div>
            )}

            <div className="sticky bottom-0 border-t border-zinc-800 bg-zinc-950/90 py-3 backdrop-blur">
              <Button onClick={save} disabled={busy}>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save {section === 'agent' ? 'agent soul' : section === 'user' ? 'user profile' : 'private vault'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}

function SectionHeader({
  id,
  icon: Icon,
  title,
  eyebrow,
  detail,
  accent = 'cyan',
}: {
  id: string;
  icon: typeof Sparkles;
  title: string;
  eyebrow: string;
  detail: string;
  accent?: 'cyan' | 'amber';
}) {
  return (
    <div className="border-b border-zinc-800 pb-4">
      <div className="flex items-center gap-3">
        <div className={cn(
          'flex h-9 w-9 items-center justify-center rounded-sm border',
          accent === 'amber' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
        )}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">{eyebrow}</p>
          <h2 id={id} className="text-base font-semibold text-zinc-100">
            {title}
          </h2>
        </div>
      </div>
      <p className="mt-3 max-w-2xl text-xs leading-relaxed text-zinc-500">{detail}</p>
    </div>
  );
}

function FieldGroup({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: typeof Sparkles;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-sm border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-zinc-500" />
          <h3 className="text-xs font-medium text-zinc-200">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
