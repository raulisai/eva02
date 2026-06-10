'use client';

import { useState } from 'react';
import {
  Fingerprint, Mail, Calendar, HardDrive, Contact, Car, Github, ShoppingCart,
  Loader2, Trash2, PlugZap, ShieldCheck, Search,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { coreFetch } from '@/lib/core-api';
import type { Integration } from '@/lib/types';

const GOOGLE_CAPABILITIES = [
  { icon: Mail,     label: 'Leer correos (Gmail)',  scope: 'gmail.readonly' },
  { icon: Mail,     label: 'Enviar correos',        scope: 'gmail.send' },
  { icon: Calendar, label: 'Calendario',            scope: 'calendar' },
  { icon: HardDrive,label: 'Drive',                 scope: 'drive.readonly' },
  { icon: Contact,  label: 'Contactos',             scope: 'contacts.readonly' },
];

const SIMPLE_PROVIDERS = [
  {
    provider: 'uber', label: 'Uber', icon: Car,
    blurb: 'API token so EVA can request rides and check trip status — every ride request goes through the Approval Engine (L2).',
    capabilities: ['Pedir viajes (con aprobación)', 'Estado del viaje', 'Estimar tarifas'],
    placeholder: 'Uber API token',
  },
  {
    provider: 'github', label: 'GitHub', icon: Github,
    blurb: 'Personal access token for the Dev Manager: repos, PRs, issues.',
    capabilities: ['Leer repos', 'Crear PRs', 'Comentar issues'],
    placeholder: 'ghp_…',
  },
  {
    provider: 'amazon', label: 'Amazon', icon: ShoppingCart,
    blurb: 'Account credential for purchase flows — every purchase requires L2 approval (action_hash + nonce).',
    capabilities: ['Buscar productos', 'Comprar (con aprobación)'],
    placeholder: 'API token',
  },
  {
    provider: 'brave_search', label: 'Brave Search', icon: Search,
    blurb: 'Optional web-search API key. EVA tries Chromium first; this is only a faster fallback for current web lookups.',
    capabilities: ['Búsqueda web actual', 'Fallback sin navegación', 'Read-only'],
    placeholder: 'BSA…',
  },
  {
    provider: 'tavily', label: 'Tavily', icon: Search,
    blurb: 'Optional research API key. Chromium remains the default path; this helps when search pages block automation.',
    capabilities: ['Búsqueda web actual', 'Research snippets', 'Read-only'],
    placeholder: 'tvly-…',
  },
  {
    provider: 'serpapi', label: 'SerpAPI', icon: Search,
    blurb: 'Optional Google results API key used only as fallback when Chromium search extraction fails.',
    capabilities: ['Resultados Google', 'Fallback de búsqueda', 'Read-only'],
    placeholder: 'SerpAPI key',
  },
];

interface CredentialsClientProps {
  initialIntegrations: Integration[];
}

export function CredentialsClient({ initialIntegrations }: CredentialsClientProps) {
  const { toast } = useToast();
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [busy, setBusy] = useState<string | null>(null);
  const [google, setGoogle] = useState({ client_id: '', client_secret: '', refresh_token: '' });
  const [googleAccount, setGoogleAccount] = useState<{ email: string; scopes: string[] } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const googleIntegration = integrations.find((integration) => integration.provider === 'google');

  function patchLocal(updated: Integration) {
    setIntegrations((prev) => {
      const exists = prev.some((integration) => integration.provider === updated.provider);
      return exists
        ? prev.map((integration) => integration.provider === updated.provider ? updated : integration)
        : [...prev, updated];
    });
  }

  async function saveGoogle() {
    setBusy('google');
    try {
      const updated = await coreFetch<Integration>('/integrations/credential/google', {
        method: 'PUT',
        body: JSON.stringify({
          secret: JSON.stringify(google),
          status: 'active',
          config: { scopes: GOOGLE_CAPABILITIES.map((capability) => capability.scope) },
        }),
      });
      patchLocal(updated);
      setGoogle({ client_id: '', client_secret: '', refresh_token: '' });
      toast('Google credential saved (encrypted)', 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function testGoogle() {
    setBusy('google-test');
    try {
      const result = await coreFetch<{ ok: boolean; email?: string; scopes?: string[]; error?: string }>(
        '/integrations/credential/google/test',
        { method: 'POST' },
      );
      if (result.ok && result.email) {
        setGoogleAccount({ email: result.email, scopes: result.scopes ?? [] });
        toast(`Google conectado: ${result.email}`, 'success');
      } else {
        setGoogleAccount(null);
        toast(result.error ?? 'Google rejected the credential', 'error');
      }
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function saveSimple(provider: string) {
    const secret = drafts[provider]?.trim();
    if (!secret) return;
    setBusy(provider);
    try {
      const updated = await coreFetch<Integration>(`/integrations/credential/${provider}`, {
        method: 'PUT',
        body: JSON.stringify({ secret, status: 'active' }),
      });
      patchLocal(updated);
      setDrafts((prev) => ({ ...prev, [provider]: '' }));
      toast(`${provider} credential saved`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function remove(provider: string) {
    setBusy(provider);
    try {
      await coreFetch(`/integrations/credential/${provider}`, { method: 'DELETE' });
      setIntegrations((prev) => prev.filter((integration) => integration.provider !== provider));
      if (provider === 'google') setGoogleAccount(null);
      toast(`${provider} credential removed`, 'info');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  const inputClass = 'w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60';

  return (
    <ScrollArea className="h-full">
      <div className="max-w-2xl p-6 space-y-6">
        <p className="flex items-start gap-2 text-xs text-zinc-500 leading-relaxed">
          <ShieldCheck className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
          Credentials let EVA act on your accounts. They are encrypted (AES-256-GCM), never returned to the
          browser, and every sensitive action they unlock still passes through the Approval Engine.
        </p>

        {/* ── Google — full integration ── */}
        <div className="border border-zinc-800 rounded-sm p-4 space-y-4 animate-fade-in">
          <div className="flex items-center gap-2">
            <Fingerprint className="w-4 h-4 text-zinc-400" />
            <span className="text-sm text-zinc-100 font-medium">Google</span>
            <Badge variant="running">FULL INTEGRATION</Badge>
            {googleIntegration?.secret_hint
              ? <Badge variant="completed">configured {googleIntegration.secret_hint}</Badge>
              : <Badge variant="cancelled">not connected</Badge>}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {GOOGLE_CAPABILITIES.map(({ icon: Icon, label, scope }) => (
              <div key={scope} className="flex items-center gap-2 text-[11px] text-zinc-400 border border-zinc-800/70 rounded-sm px-2.5 py-1.5">
                <Icon className="w-3 h-3 text-cyan-400/70" />
                <span className="flex-1">{label}</span>
                <code className="text-[9px] text-zinc-600">{scope}</code>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              Create an OAuth client in Google Cloud Console (type: Web), authorize the scopes above via the
              OAuth Playground, and paste the three values. EVA exchanges the refresh token server-side.
            </p>
            <input
              aria-label="Google client ID"
              value={google.client_id}
              onChange={(event) => setGoogle((prev) => ({ ...prev, client_id: event.target.value }))}
              placeholder="Client ID — …apps.googleusercontent.com"
              className={inputClass}
            />
            <input
              aria-label="Google client secret"
              type="password"
              autoComplete="off"
              value={google.client_secret}
              onChange={(event) => setGoogle((prev) => ({ ...prev, client_secret: event.target.value }))}
              placeholder="Client secret — GOCSPX-…"
              className={inputClass}
            />
            <input
              aria-label="Google refresh token"
              type="password"
              autoComplete="off"
              value={google.refresh_token}
              onChange={(event) => setGoogle((prev) => ({ ...prev, refresh_token: event.target.value }))}
              placeholder="Refresh token — 1//…"
              className={inputClass}
            />
          </div>

          {googleAccount && (
            <div className="border border-emerald-500/40 bg-emerald-500/5 rounded-sm p-3 space-y-1 animate-slide-up">
              <p className="text-xs font-mono text-emerald-400">Conectado como {googleAccount.email}</p>
              <p className="text-[10px] font-mono text-zinc-500 break-all">
                scopes: {googleAccount.scopes.map((scope) => scope.split('/').pop()).join(', ') || '—'}
              </p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1 border-t border-zinc-800">
            <Button
              size="sm"
              onClick={saveGoogle}
              disabled={busy !== null || !google.client_id || !google.client_secret || !google.refresh_token}
            >
              {busy === 'google' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save credential
            </Button>
            <Button size="sm" variant="outline" onClick={testGoogle} disabled={busy !== null || !googleIntegration}>
              {busy === 'google-test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
              Test — read my Gmail profile
            </Button>
            {googleIntegration && (
              <Button size="sm" variant="destructive" onClick={() => remove('google')} disabled={busy !== null}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* ── Simple token providers ── */}
        {SIMPLE_PROVIDERS.map(({ provider, label, icon: Icon, blurb, capabilities, placeholder }) => {
          const current = integrations.find((integration) => integration.provider === provider);
          return (
            <div key={provider} className="border border-zinc-800 rounded-sm p-4 space-y-3 animate-fade-in">
              <div className="flex items-center gap-2">
                <Icon className="w-4 h-4 text-zinc-400" />
                <span className="text-sm text-zinc-100 font-medium">{label}</span>
                {current?.secret_hint
                  ? <Badge variant="completed">configured {current.secret_hint}</Badge>
                  : <Badge variant="cancelled">not connected</Badge>}
              </div>
              <p className="text-[11px] text-zinc-600">{blurb}</p>
              <div className="flex flex-wrap gap-1.5">
                {capabilities.map((capability) => (
                  <span key={capability} className={cn(
                    'text-[10px] font-mono px-2 py-0.5 rounded-sm border',
                    current ? 'border-cyan-500/30 text-cyan-300' : 'border-zinc-800 text-zinc-600',
                  )}>
                    {capability}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  aria-label={`${label} token`}
                  value={drafts[provider] ?? ''}
                  onChange={(event) => setDrafts((prev) => ({ ...prev, [provider]: event.target.value }))}
                  placeholder={placeholder}
                  className={inputClass}
                />
                <Button size="sm" onClick={() => saveSimple(provider)} disabled={busy !== null || !drafts[provider]?.trim()}>
                  {busy === provider && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Save
                </Button>
                {current && (
                  <Button size="sm" variant="destructive" onClick={() => remove(provider)} disabled={busy !== null}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
