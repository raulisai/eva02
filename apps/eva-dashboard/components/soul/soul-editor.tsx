'use client';

import { useState } from 'react';
import { Sparkles, Save, Loader2, CheckCircle2, XCircle, Plus, Trash2, Shield } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
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
  const [privateContext, setPrivateContext] = useState('');
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
      if (privateContext.trim()) {
        await coreFetch('/agent/soul/private-context', {
          method: 'POST',
          body: JSON.stringify({ text: privateContext }),
        });
        setPrivateContext('');
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
      <div className="max-w-2xl p-6 space-y-6">
        <section className="space-y-1">
          <p className="text-xs text-zinc-300">Soul identity</p>
          <p className="text-[11px] text-zinc-600 leading-relaxed">
            Define quien es EVA y como se comporta. Tu informacion vive en secciones separadas para que el agente no confunda su identidad con la tuya.
          </p>
        </section>

        <section className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-zinc-300" htmlFor="soul-name">
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            Agent name
          </label>
          <input
            id="soul-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500/60"
          />
        </section>

        <section className="space-y-2">
          <label className="block text-xs text-zinc-300" htmlFor="soul-persona">Identity & behavior</label>
          <p className="text-[11px] text-zinc-600">
            Quien es EVA, tono, prioridades, limites y forma de comportarse.
          </p>
          <textarea
            id="soul-persona"
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            rows={6}
            placeholder="EVA es mi agente personal. Es directa, cuidadosa, leal a mis preferencias, security-first y siempre intenta resolver antes de rendirse…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 resize-y"
          />
        </section>

        <section className="space-y-2">
          <label className="block text-xs text-zinc-300" htmlFor="soul-directives">Standing directives</label>
          <p className="text-[11px] text-zinc-600">Reglas permanentes, una por linea. Siempre se aplican.</p>
          <textarea
            id="soul-directives"
            value={directivesText}
            onChange={(event) => setDirectivesText(event.target.value)}
            rows={5}
            placeholder={'Never spend money without approval\nAlways answer in Spanish'}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 resize-y"
          />
        </section>

        <section className="space-y-3">
          <div>
            <span className="block text-xs text-zinc-300">A quien sirve</span>
            <p className="text-[11px] text-zinc-600 mt-1">
              Perfil personal del dueño/usuario de EVA: nombre, como debe llamarte, ubicacion, salud, trabajo y preferencias.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
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
        </section>

        <section className="space-y-2">
          <label className="block text-xs text-zinc-300" htmlFor="user-expectations">Que esperas de EVA</label>
          <textarea
            id="user-expectations"
            value={expectations}
            onChange={(event) => setExpectations(event.target.value)}
            rows={3}
            placeholder="Ej. Que sea proactiva, recuerde contexto familiar, resuelva primero y solo pregunte cuando falte informacion critica."
            className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 resize-y"
          />
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="block text-xs text-zinc-300">Mapa de familiares y contactos</span>
              <p className="text-[11px] text-zinc-600 mt-1">
                Ensena a EVA que mama, mamá o mi madre apuntan a la misma persona antes de buscar contactos.
              </p>
            </div>
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
          </div>
          <div className="space-y-2">
            {relationships.map((entry, index) => (
              <div key={entry.id} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 border border-zinc-800 rounded-sm p-2">
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
                  className="col-span-2 bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
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
        </section>

        <section className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-zinc-300" htmlFor="private-context">
            <Shield className="w-3.5 h-3.5 text-amber-300" />
            Contexto privado cifrado
          </label>
          <p className="text-[11px] text-zinc-600">
            Se guarda con AES-256-GCM en eva-core y no se devuelve al navegador. Hint actual: {initialSoul?.private_context_hint ?? 'sin datos privados'}.
          </p>
          <textarea
            id="private-context"
            value={privateContext}
            onChange={(event) => setPrivateContext(event.target.value)}
            rows={5}
            placeholder="Datos sensibles que EVA debe usar pero no mostrar en la Data API. Al guardar, este cuadro se limpia."
            className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/60 resize-y"
          />
        </section>

        <section className="space-y-3">
          <div>
            <span className="block text-xs text-zinc-300">Cowork context</span>
            <p className="text-[11px] text-zinc-600 mt-1">
              Informacion operativa para que EVA pueda ayudarte como coworker: agenda, pendientes, metas, familia, redes y rutinas.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {COWORK_FIELDS.map(({ key, label, placeholder }) => (
              <label key={key} className="space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">{label}</span>
                <textarea
                  value={cowork[key]}
                  onChange={(event) => setCowork((prev) => ({ ...prev, [key]: event.target.value }))}
                  placeholder={placeholder}
                  rows={3}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 resize-y"
                />
              </label>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <span className="block text-xs text-zinc-300">Autonomy level (agency)</span>
          <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Autonomy level">
            {AUTONOMY_LEVELS.map(({ level, name: levelName }) => (
              <button
                key={level}
                role="radio"
                aria-checked={autonomy === level}
                onClick={() => setAutonomy(level)}
                className={cn(
                  'border rounded-sm px-2 py-3 text-center transition-all',
                  autonomy === level
                    ? 'border-cyan-500/60 bg-cyan-500/10 text-cyan-300'
                    : 'border-zinc-800 text-zinc-500 hover:border-zinc-700',
                )}
              >
                <div className="font-mono text-sm">L{level}</div>
                <div className="text-[10px] mt-1">{levelName}</div>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-zinc-600">{AUTONOMY_LEVELS[autonomy].blurb}</p>
          <p className="text-[11px] font-mono text-amber-400/80">
            Raising autonomy never bypasses the Approval Engine for money / production / data actions.
          </p>
        </section>

        {feedback && (
          <div className={cn(
            'flex items-center gap-2 text-xs font-mono rounded-sm border px-3 py-2',
            feedback.ok ? 'border-emerald-500/30 text-emerald-400' : 'border-red-500/30 text-red-400',
          )}>
            {feedback.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
            {feedback.text}
          </div>
        )}

        <div className="pt-2 border-t border-zinc-800">
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save soul
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}
