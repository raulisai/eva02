'use client';

import { useState } from 'react';
import { Check, Eye, EyeOff, Star, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ClaudeAuthOption, DevHumanTask } from '@/lib/dev-studio-types';
import { devStudioApi } from '@/lib/dev-studio-api';

const FALLBACK_OPTIONS: ClaudeAuthOption[] = [
  { method: 'oauth', label: 'Token de suscripción (OAuth)', description: 'Usa tu plan Max/Pro ya contratado. No paga por token de API.', envVar: 'CLAUDE_CODE_OAUTH_TOKEN', recommended: true, hint: 'Genera el token con `claude setup-token` y pégalo aquí.' },
  { method: 'api_key', label: 'API key de Anthropic', description: 'Pay-per-token con una API key (sk-ant-…).', envVar: 'ANTHROPIC_API_KEY', hint: 'Crea una key en console.anthropic.com → API Keys.' },
  { method: 'org', label: 'Credencial de la organización', description: 'Token de suscripción compartido a nivel organización.', envVar: 'CLAUDE_CODE_OAUTH_TOKEN', hint: 'Token OAuth de la cuenta de la organización.' },
];

interface ClaudeCodeAuthPanelProps {
  task: DevHumanTask;
  onUpdated?: () => void;
}

export function ClaudeCodeAuthPanel({ task, onUpdated }: ClaudeCodeAuthPanelProps) {
  const options = ((task.instructions?.options as ClaudeAuthOption[] | undefined) ?? FALLBACK_OPTIONS);
  const [method, setMethod] = useState<string>(options.find((o) => o.recommended)?.method ?? options[0]?.method ?? 'oauth');
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = options.find((o) => o.method === method);

  async function submit() {
    if (!token.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await devStudioApi.saveClaudeCodeCredential(task.session_id, method, token.trim());
      onUpdated?.();
    } catch (e) {
      setError((e as Error).message || 'No se pudo guardar la credencial');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-md border border-cyan-500/20 bg-cyan-500/5 px-3 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <Terminal className="h-3.5 w-3.5 text-cyan-400" />
        <span className="text-[11px] font-semibold text-zinc-200">{task.title}</span>
      </div>
      {task.description && <p className="text-[11px] text-zinc-500 leading-relaxed">{task.description}</p>}

      {/* Option cards */}
      <div className="space-y-1.5">
        {options.map((opt) => {
          const active = opt.method === method;
          return (
            <button
              key={opt.method}
              type="button"
              onClick={() => setMethod(opt.method)}
              className={cn(
                'w-full text-left rounded-md border px-2.5 py-2 transition-colors',
                active ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded-full border shrink-0',
                  active ? 'border-cyan-400 bg-cyan-400' : 'border-zinc-700',
                )}>
                  {active && <Check className="h-2.5 w-2.5 text-zinc-950" />}
                </span>
                <span className="text-[11px] font-medium text-zinc-200">{opt.label}</span>
                {opt.recommended && (
                  <span className="ml-auto flex items-center gap-0.5 text-[9px] font-mono text-amber-400">
                    <Star className="h-2.5 w-2.5 fill-amber-400" /> recomendado
                  </span>
                )}
              </div>
              <p className="text-[10px] text-zinc-500 mt-0.5 ml-5.5 pl-0.5">{opt.description}</p>
            </button>
          );
        })}
      </div>

      {/* Token input */}
      <div className="space-y-1.5">
        {selected?.hint && <p className="text-[10px] text-zinc-600 font-mono">{selected.hint}</p>}
        <div className="relative">
          <input
            type={show ? 'text' : 'password'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={method === 'api_key' ? 'sk-ant-…' : 'token de Claude Code'}
            className="w-full rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 pr-8 text-xs font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
          />
          <button type="button" onClick={() => setShow((s) => !s)}
            className="absolute right-2 top-1.5 text-zinc-600 hover:text-zinc-400">
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <p className="text-[9px] text-zinc-700">
          El token se guarda cifrado en el secret manager y se inyecta en la máquina del agente en runtime. EVA nunca lo muestra.
        </p>
      </div>

      {error && <p className="text-[10px] text-red-400">{error}</p>}

      <button onClick={submit} disabled={loading || !token.trim()}
        className="w-full rounded border border-cyan-500/20 bg-cyan-500/10 py-1.5 text-xs font-mono text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-40 transition-colors">
        {loading ? 'Conectando…' : 'Conectar Claude Code y continuar'}
      </button>
    </div>
  );
}
