'use client';

import { useState } from 'react';
import { KeyRound, Trash2, Loader2, CheckCircle2, XCircle, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { coreFetch } from '@/lib/core-api';
import type { Integration } from '@/lib/types';

const PROVIDERS = [
  { provider: 'anthropic',  label: 'Anthropic',  placeholder: 'sk-ant-…', blurb: 'Claude models (planner, intent router, memory agent).' },
  { provider: 'openai',     label: 'OpenAI',     placeholder: 'sk-…',     blurb: 'GPT models and embeddings.' },
  { provider: 'google',     label: 'Google',     placeholder: 'AIza…',    blurb: 'Gemini models.' },
  { provider: 'groq',       label: 'Groq',       placeholder: 'gsk_…',    blurb: 'Low-latency open models (fast path).' },
  { provider: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…',  blurb: 'Fallback multi-provider routing.' },
];

interface ModelsClientProps {
  initialIntegrations: Integration[];
}

export function ModelsClient({ initialIntegrations }: ModelsClientProps) {
  const { toast } = useToast();
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [latency, setLatency] = useState<Record<string, number>>({});

  async function testProvider(provider: string) {
    setBusy(`test-${provider}`);
    try {
      const result = await coreFetch<{ ok: boolean; latency_ms?: number; detail?: string; error?: string }>(
        `/integrations/model/${provider}/test`,
        { method: 'POST' },
      );
      if (result.ok) {
        setLatency((prev) => ({ ...prev, [provider]: result.latency_ms ?? 0 }));
        setFeedback((prev) => ({ ...prev, [provider]: { ok: true, text: `Connected in ${result.latency_ms}ms — ${result.detail}` } }));
        toast(`${provider}: ${result.latency_ms}ms ⚡`, 'success');
      } else {
        setFeedback((prev) => ({ ...prev, [provider]: { ok: false, text: result.error ?? 'Connection failed' } }));
        toast(`${provider}: ${result.error}`, 'error');
      }
    } catch (error) {
      setFeedback((prev) => ({ ...prev, [provider]: { ok: false, text: (error as Error).message } }));
    } finally {
      setBusy(null);
    }
  }

  function patchLocal(updated: Integration) {
    setIntegrations((prev) => {
      const exists = prev.some((integration) => integration.provider === updated.provider);
      return exists
        ? prev.map((integration) => integration.provider === updated.provider ? updated : integration)
        : [...prev, updated];
    });
  }

  async function save(provider: string) {
    const secret = drafts[provider]?.trim();
    if (!secret) return;
    setBusy(provider);
    try {
      const updated = await coreFetch<Integration>(`/integrations/model/${provider}`, {
        method: 'PUT',
        body: JSON.stringify({ secret, status: 'active' }),
      });
      patchLocal(updated);
      setDrafts((prev) => ({ ...prev, [provider]: '' }));
      setFeedback((prev) => ({ ...prev, [provider]: { ok: true, text: 'Key saved (encrypted)' } }));
    } catch (error) {
      setFeedback((prev) => ({ ...prev, [provider]: { ok: false, text: (error as Error).message } }));
    } finally {
      setBusy(null);
    }
  }

  async function remove(provider: string) {
    setBusy(provider);
    try {
      await coreFetch(`/integrations/model/${provider}`, { method: 'DELETE' });
      setIntegrations((prev) => prev.filter((integration) => integration.provider !== provider));
      setFeedback((prev) => ({ ...prev, [provider]: { ok: true, text: 'Key removed' } }));
    } catch (error) {
      setFeedback((prev) => ({ ...prev, [provider]: { ok: false, text: (error as Error).message } }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="max-w-2xl p-6 space-y-4">
        <p className="text-xs text-zinc-500">
          Keys are encrypted with AES-256-GCM before touching the database and are never returned to the browser —
          only the last 4 characters are shown.
        </p>

        {PROVIDERS.map(({ provider, label, placeholder, blurb }) => {
          const current = integrations.find((integration) => integration.provider === provider);
          const note = feedback[provider];
          return (
            <div key={provider} className="border border-zinc-800 rounded-sm p-4 space-y-3">
              <div className="flex items-center gap-2">
                <KeyRound className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-sm text-zinc-100 font-medium">{label}</span>
                {current?.secret_hint
                  ? <Badge variant="completed">configured {current.secret_hint}</Badge>
                  : <Badge variant="cancelled">not set</Badge>}
                {latency[provider] !== undefined && (
                  <Badge variant="running">
                    <Zap className="w-2.5 h-2.5" />
                    {latency[provider]}ms
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-zinc-600">{blurb}</p>

              <div className="flex items-center gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  aria-label={`${label} API key`}
                  value={drafts[provider] ?? ''}
                  onChange={(event) => setDrafts((prev) => ({ ...prev, [provider]: event.target.value }))}
                  placeholder={placeholder}
                  className="flex-1 bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
                />
                <Button size="sm" onClick={() => save(provider)} disabled={busy !== null || !drafts[provider]?.trim()}>
                  {busy === provider && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => testProvider(provider)}
                  disabled={busy !== null}
                  title="Test connectivity with the stored key (env fallback)"
                >
                  {busy === `test-${provider}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                  Test
                </Button>
                {current && (
                  <Button size="sm" variant="destructive" onClick={() => remove(provider)} disabled={busy !== null}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>

              {note && (
                <div className={cn(
                  'flex items-center gap-2 text-[11px] font-mono',
                  note.ok ? 'text-emerald-400' : 'text-red-400',
                )}>
                  {note.ok ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                  {note.text}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
