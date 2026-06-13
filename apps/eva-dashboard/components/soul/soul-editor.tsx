'use client';

import { useState } from 'react';
import { Bot, CheckCircle2, Loader2, Save, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { AgentSoul } from '@/lib/types';

const AUTONOMY_LEVELS = [
  { level: 0 as const, name: 'Observer', blurb: 'Every action requires explicit approval.' },
  { level: 1 as const, name: 'Assisted', blurb: 'Sensitive actions (L1+) require approval.' },
  { level: 2 as const, name: 'Semi-autonomous', blurb: 'Only money / production / data actions (L2+) require approval.' },
  { level: 3 as const, name: 'Autonomous', blurb: 'Only critical L3 actions require dual approval.' },
];

interface SoulEditorProps {
  orgId: string;
  initialSoul: AgentSoul | null;
}

export function SoulEditor({ orgId, initialSoul }: SoulEditorProps) {
  const [name, setName] = useState(initialSoul?.name ?? 'EVA');
  const [persona, setPersona] = useState(initialSoul?.persona ?? '');
  const [directivesText, setDirectivesText] = useState(
    Array.isArray(initialSoul?.directives) ? (initialSoul.directives as string[]).join('\n') : '',
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
      const { error } = await supabase
        .from('agent_souls')
        .upsert({
          org_id: orgId,
          name,
          persona,
          directives,
          autonomy_level: autonomy,
          persona_context: initialSoul?.persona_context ?? {},
        }, { onConflict: 'org_id' });
      if (error) throw error;
      setFeedback({ ok: true, text: 'Agent soul updated' });
    } catch (error) {
      setFeedback({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl p-6">
        <section className="space-y-6" aria-labelledby="agent-section-title">
          <div className="border-b border-zinc-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-sm border border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Identidad del agente</p>
                <h2 id="agent-section-title" className="text-base font-semibold text-zinc-100">
                  Agente EVA
                </h2>
              </div>
            </div>
            <p className="mt-3 max-w-2xl text-xs leading-relaxed text-zinc-500">
              Aqui vive la identidad de EVA: nombre, personalidad, directivas permanentes y autonomia. Tu informacion personal ahora esta separada en Mi Perfil.
            </p>
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-4">
              <label className="block space-y-1" htmlFor="soul-name">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Nombre del agente</span>
                <input
                  id="soul-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="w-full rounded-sm border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-cyan-500/60 focus:outline-none"
                />
              </label>

              <label className="block space-y-1" htmlFor="soul-persona">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Personalidad y comportamiento</span>
                <textarea
                  id="soul-persona"
                  value={persona}
                  onChange={(event) => setPersona(event.target.value)}
                  rows={10}
                  placeholder="EVA es mi agente personal. Es directa, cuidadosa, security-first y siempre intenta resolver antes de rendirse..."
                  className="w-full resize-y rounded-sm border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-cyan-500/60 focus:outline-none"
                />
              </label>

              <label className="block space-y-1" htmlFor="soul-directives">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Directivas permanentes</span>
                <textarea
                  id="soul-directives"
                  value={directivesText}
                  onChange={(event) => setDirectivesText(event.target.value)}
                  rows={7}
                  placeholder={'Never spend money without approval\nAlways answer in Spanish'}
                  className="w-full resize-y rounded-sm border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-cyan-500/60 focus:outline-none"
                />
              </label>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                <Bot className="h-3.5 w-3.5" />
                Autonomia
              </div>
              <div className="grid gap-2" role="radiogroup" aria-label="Autonomy level">
                {AUTONOMY_LEVELS.map(({ level, name: levelName, blurb }) => (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={autonomy === level}
                    onClick={() => setAutonomy(level)}
                    className={cn(
                      'rounded-sm border px-3 py-2 text-left transition-all',
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
              <div className="flex gap-2 border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] font-mono leading-relaxed text-amber-200/80">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                Money, production and data actions still use the Approval Engine.
              </div>
            </div>
          </div>

          {feedback && (
            <div className={cn(
              'flex items-center gap-2 rounded-sm border px-3 py-2 font-mono text-xs',
              feedback.ok ? 'border-emerald-500/30 text-emerald-400' : 'border-red-500/30 text-red-400',
            )}>
              {feedback.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
              {feedback.text}
            </div>
          )}

          <div className="sticky bottom-0 border-t border-zinc-800 bg-zinc-950/90 py-3 backdrop-blur">
            <Button onClick={save} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save agent soul
            </Button>
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}
