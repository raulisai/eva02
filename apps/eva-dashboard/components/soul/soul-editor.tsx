'use client';

import { useState } from 'react';
import { Sparkles, Save, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
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

export function SoulEditor({ orgId, initialSoul }: SoulEditorProps) {
  const [name, setName] = useState(initialSoul?.name ?? 'EVA');
  const [persona, setPersona] = useState(initialSoul?.persona ?? '');
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
      const { error } = await supabase
        .from('agent_souls')
        .upsert({
          org_id: orgId,
          name,
          persona,
          directives,
          autonomy_level: autonomy,
          model_prefs: initialSoul?.model_prefs ?? {},
        }, { onConflict: 'org_id' });
      if (error) throw error;
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
          <label className="block text-xs text-zinc-300" htmlFor="soul-persona">Persona</label>
          <p className="text-[11px] text-zinc-600">
            Injected into every planner / intent prompt. Who is EVA, what tone, what priorities.
          </p>
          <textarea
            id="soul-persona"
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            rows={6}
            placeholder="EVA is a pragmatic operations agent. Direct, concise, security-first…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60 resize-y"
          />
        </section>

        <section className="space-y-2">
          <label className="block text-xs text-zinc-300" htmlFor="soul-directives">Standing directives</label>
          <p className="text-[11px] text-zinc-600">One per line. Always-on rules the agent must obey.</p>
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
