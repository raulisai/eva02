'use client';

import { useEffect, useState } from 'react';
import type React from 'react';
import {
  Fingerprint, Mail, Calendar, HardDrive, Contact, Car, Github, ShoppingCart,
  Loader2, Trash2, PlugZap, ShieldCheck, Search, KeyRound, LogIn, Hash,
  UtensilsCrossed, Upload, CheckCircle2, XCircle,
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

interface GoogleWebLoginResult {
  ok: boolean;
  state: 'logged_in' | 'email_required' | 'account_picker' | 'password_required' | 'consent_required' | 'mfa_required' | 'challenge_required' | 'blocked' | 'loading' | 'unknown' | 'no_credential';
  email?: string;
  screenshot?: { image_base64: string; mime_type: string };
  text: string;
}

interface EmailLoginResult {
  ok: boolean;
  reason: 'code_required' | 'already_logged_in' | 'no_email_field' | 'logged_in' | 'invalid_code' | 'no_active_session' | 'unknown';
  session_id?: string;
  screenshot?: { image_base64: string; mime_type: string };
  text: string;
}

type EmailLoginStep = 'idle' | 'code_required' | 'done' | 'error';

interface EmailLoginState {
  step: EmailLoginStep;
  email: string;
  password?: string;
  code: string;
  result: EmailLoginResult | null;
  shot: string | null;
}

function initEmailLogin(): EmailLoginState {
  return { step: 'idle', email: '', password: '', code: '', result: null, shot: null };
}

const inputClass = 'w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60';

// ── Shared email-login section — must live OUTSIDE CredentialsClient so React
// doesn't treat it as a new component type on every parent render (which would
// reset focus and discard text after each keystroke).
function EmailLoginSection({
  service,
  label,
  icon: Icon,
  blurb,
  capabilities,
  state,
  setState,
  busy,
  onStartEmailLogin,
  onSubmitCode,
  onVerifySession,
  showPassword,
}: {
  service: 'uber' | 'rappi';
  label: string;
  icon: React.ElementType;
  blurb: string;
  capabilities: string[];
  state: EmailLoginState;
  setState: React.Dispatch<React.SetStateAction<EmailLoginState>>;
  busy: string | null;
  onStartEmailLogin: (service: 'uber' | 'rappi', setState: React.Dispatch<React.SetStateAction<EmailLoginState>>) => void;
  onSubmitCode: (service: 'uber' | 'rappi', state: EmailLoginState, setState: React.Dispatch<React.SetStateAction<EmailLoginState>>) => void;
  onVerifySession: (service: 'uber' | 'rappi', setState: React.Dispatch<React.SetStateAction<EmailLoginState>>) => void;
  showPassword?: boolean;
}) {
  const isEmailBusy = busy === `${service}-email`;
  const isCodeBusy = busy === `${service}-code`;
  const isVerifyBusy = busy === `${service}-verify`;
  const isBusy = isEmailBusy || isCodeBusy || isVerifyBusy;

  return (
    <div className="border border-zinc-800 rounded-sm p-4 space-y-3 animate-fade-in">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-zinc-400" />
        <span className="text-sm text-zinc-100 font-medium">{label}</span>
        <Badge variant="running">BROWSER</Badge>
        {state.step === 'done'
          ? <Badge variant="completed">sesión activa</Badge>
          : <Badge variant="cancelled">sin sesión</Badge>}
      </div>

      <p className="text-[11px] text-zinc-600 leading-relaxed">{blurb}</p>

      <div className="flex flex-wrap gap-1.5">
        {capabilities.map((cap) => (
          <span key={cap} className={cn(
            'text-[10px] font-mono px-2 py-0.5 rounded-sm border',
            state.step === 'done' ? 'border-cyan-500/30 text-cyan-300' : 'border-zinc-800 text-zinc-600',
          )}>
            {cap}
          </span>
        ))}
      </div>

      {/* Step 1 — email input */}
      <div className="space-y-2">
        <p className="text-[10px] text-zinc-500 uppercase tracking-wide">Paso 1 — Correo electrónico</p>
        <div className="flex flex-col gap-2 md:flex-row">
          <input
            aria-label={`${label} email`}
            type="email"
            autoComplete="email"
            value={state.email}
            onChange={(e) => setState((prev) => ({ ...prev, email: e.target.value }))}
            placeholder="tu@correo.com"
            className={cn(inputClass, 'flex-[2]')}
            disabled={isBusy || state.step === 'done'}
          />
          {showPassword && (
            <input
              aria-label={`${label} password`}
              type="password"
              autoComplete="current-password"
              value={state.password || ''}
              onChange={(e) => setState((prev) => ({ ...prev, password: e.target.value }))}
              placeholder="Contraseña (opcional)"
              className={cn(inputClass, 'flex-[1.5]')}
              disabled={isBusy || state.step === 'done'}
            />
          )}
          <Button
            size="sm"
            onClick={() => onStartEmailLogin(service, setState)}
            disabled={isBusy || !state.email.trim() || state.step === 'done'}
            className="md:w-auto w-full flex-shrink-0"
          >
            {isEmailBusy
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <LogIn className="w-3.5 h-3.5" />}
            Iniciar sesión
          </Button>
        </div>
      </div>

      {/* Step 2 — code input (shown only when waiting for code) */}
      {(state.step === 'code_required' || state.step === 'error') && (
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wide">
            Paso 2 — Código de verificación
          </p>
          <p className="text-[11px] text-amber-300/80">
            Revisa tu correo o teléfono y escribe el código que recibiste.
          </p>
          <div className="flex gap-2">
            <input
              aria-label={`${label} código`}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              value={state.code}
              onChange={(e) => setState((prev) => ({ ...prev, code: e.target.value.replace(/\D/g, '') }))}
              placeholder="ej. 123456"
              className={cn(inputClass, 'flex-1 font-mono tracking-widest')}
              disabled={isCodeBusy}
            />
            <Button
              size="sm"
              onClick={() => onSubmitCode(service, state, setState)}
              disabled={isCodeBusy || state.code.length < 4}
            >
              {isCodeBusy
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Hash className="w-3.5 h-3.5" />}
              Enviar código
            </Button>
          </div>
        </div>
      )}

      {/* Result text */}
      {state.result && (
        <div className={cn(
          'flex items-start gap-2 text-xs font-mono rounded-sm border px-3 py-2',
          state.result.ok
            ? 'border-emerald-500/30 text-emerald-400'
            : 'border-amber-500/30 text-amber-300',
        )}>
          <ShieldCheck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span className="break-words">{state.result.text}</span>
        </div>
      )}

      {/* Screenshot */}
      {state.shot && (
        <div className="inline-block border border-zinc-800 rounded-sm bg-zinc-950 p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={state.shot} alt={`${label} screenshot`} className="w-[28rem] max-w-full h-auto" />
        </div>
      )}

      {/* Action buttons (Verify / Reset) */}
      <div className="pt-1 border-t border-zinc-800 flex flex-wrap gap-2">
        {(state.step === 'done' || state.step === 'error') && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setState(initEmailLogin())}
            disabled={isBusy}
          >
            Reiniciar login
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => onVerifySession(service, setState)}
          disabled={isBusy}
        >
          {isVerifyBusy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <PlugZap className="w-3.5 h-3.5" />
          )}
          Verificar sesión
        </Button>
      </div>
    </div>
  );
}

export function CredentialsClient({ initialIntegrations }: CredentialsClientProps) {
  const { toast } = useToast();
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [busy, setBusy] = useState<string | null>(null);
  const [google, setGoogle] = useState({ client_id: '', client_secret: '', refresh_token: '' });
  const [googleWebCookies, setGoogleWebCookies] = useState('');
  const [googleWebResult, setGoogleWebResult] = useState<GoogleWebLoginResult | null>(null);
  const [googleWebImportResult, setGoogleWebImportResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [googleWebShot, setGoogleWebShot] = useState<string | null>(null);
  const [googleAccount, setGoogleAccount] = useState<{
    email: string;
    scopes: string[];
    services: { gmail: { ok: boolean; error?: string }; calendar: { ok: boolean; error?: string }; drive: { ok: boolean; error?: string } };
  } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [uberLogin, setUberLogin] = useState<EmailLoginState>(initEmailLogin());
  const [rappiLogin, setRappiLogin] = useState<EmailLoginState>(initEmailLogin());

  useEffect(() => {
    async function loadStatuses() {
      try {
        const uberRes = await coreFetch<{ has_session: boolean }>('/integrations/uber/status');
        if (uberRes.has_session) {
          setUberLogin((prev) => ({ ...prev, step: 'done' }));
        }
      } catch (err) {
        console.error('Failed to load Uber session status', err);
      }
      try {
        const rappiRes = await coreFetch<{ has_session: boolean }>('/integrations/rappi/status');
        if (rappiRes.has_session) {
          setRappiLogin((prev) => ({ ...prev, step: 'done' }));
        }
      } catch (err) {
        console.error('Failed to load Rappi session status', err);
      }
    }
    loadStatuses();
  }, []);

  const googleIntegration = integrations.find((i) => i.provider === 'google');

  function patchLocal(updated: Integration) {
    setIntegrations((prev) => {
      const exists = prev.some((i) => i.provider === updated.provider);
      return exists
        ? prev.map((i) => i.provider === updated.provider ? updated : i)
        : [...prev, updated];
    });
  }

  // ── Google OAuth ──────────────────────────────────────────────────────────

  async function saveGoogle() {
    setBusy('google');
    try {
      const updated = await coreFetch<Integration>('/integrations/credential/google', {
        method: 'PUT',
        body: JSON.stringify({
          secret: JSON.stringify(google),
          status: 'active',
          config: { scopes: GOOGLE_CAPABILITIES.map((c) => c.scope) },
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
      const result = await coreFetch<{
        ok: boolean;
        email?: string;
        scopes: string[];
        services?: { gmail: { ok: boolean; error?: string }; calendar: { ok: boolean; error?: string }; drive: { ok: boolean; error?: string } };
        error?: string;
      }>('/integrations/credential/google/test/full', { method: 'POST' });

      if (!result.ok && result.error && !result.services) {
        setGoogleAccount(null);
        toast(`Error de credencial: ${result.error}`, 'error');
        return;
      }

      const services = result.services ?? { gmail: { ok: false }, calendar: { ok: false }, drive: { ok: false } };
      if (result.email) {
        setGoogleAccount({ email: result.email, scopes: result.scopes ?? [], services });
      } else {
        setGoogleAccount(null);
      }

      if (result.ok) {
        toast(`Google conectado: ${result.email} — Gmail ✓ Calendar ✓ Drive ✓`, 'success');
        return;
      }

      const failing = ([
        !services.gmail.ok    && `Gmail: ${services.gmail.error ?? 'sin acceso'}`,
        !services.calendar.ok && `Calendar: ${services.calendar.error ?? 'sin acceso'}`,
        !services.drive.ok    && `Drive: ${services.drive.error ?? 'sin acceso'}`,
      ] as (string | false)[]).filter(Boolean) as string[];

      if (failing.length > 0) {
        toast(`Acceso parcial — faltan permisos:\n${failing.join('\n')}`, 'error');
      } else {
        toast(result.error ?? 'Google: respuesta inesperada', 'error');
      }
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  // ── Google Web Login — cookie import ─────────────────────────────────────

  async function importGoogleSession() {
    const raw = googleWebCookies.trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      toast('El JSON de cookies no es válido. Exporta de nuevo desde Cookie-Editor.', 'error');
      return;
    }
    setBusy('google-web-import');
    setGoogleWebImportResult(null);
    setGoogleWebResult(null);
    setGoogleWebShot(null);
    try {
      const result = await coreFetch<{ ok: boolean; text: string }>(
        '/integrations/google-web/import-session',
        { method: 'POST', body: JSON.stringify({ cookies: parsed }) },
      );
      setGoogleWebImportResult(result);
      if (result.ok) setGoogleWebCookies('');
      toast(result.text, result.ok ? 'success' : 'error');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function testGoogleWebSession() {
    setBusy('google-web-test');
    setGoogleWebResult(null);
    setGoogleWebShot(null);
    try {
      const result = await coreFetch<GoogleWebLoginResult>('/integrations/google-web/start-session', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setGoogleWebResult(result);
      if (result.screenshot?.image_base64) {
        setGoogleWebShot(`data:${result.screenshot.mime_type};base64,${result.screenshot.image_base64}`);
      }
      toast(result.text, result.ok ? 'success' : 'info');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  // ── Generic email-login + OTP flow ────────────────────────────────────────

  async function startEmailLogin(
    service: 'uber' | 'rappi',
    setState: React.Dispatch<React.SetStateAction<EmailLoginState>>,
  ) {
    const loginState = service === 'uber' ? uberLogin : rappiLogin;
    const email = loginState.email;
    const password = loginState.password;
    if (!email.trim()) return;
    setBusy(`${service}-email`);
    setState((prev) => ({ ...prev, result: null, shot: null }));
    try {
      const result = await coreFetch<EmailLoginResult>(
        `/integrations/${service}/start-email-login`,
        {
          method: 'POST',
          body: JSON.stringify({
            email: email.trim(),
            password: password?.trim() || undefined,
          }),
        },
      );
      const shot = result.screenshot?.image_base64
        ? `data:${result.screenshot.mime_type};base64,${result.screenshot.image_base64}`
        : null;
      setState((prev) => ({
        ...prev,
        result,
        shot,
        step: result.reason === 'code_required' ? 'code_required'
          : result.ok ? 'done' : 'error',
      }));
      toast(result.text, result.ok ? 'success' : 'info');
    } catch (error) {
      toast((error as Error).message, 'error');
      setState((prev) => ({ ...prev, step: 'error' }));
    } finally {
      setBusy(null);
    }
  }

  async function submitLoginCode(
    service: 'uber' | 'rappi',
    state: EmailLoginState,
    setState: React.Dispatch<React.SetStateAction<EmailLoginState>>,
  ) {
    if (!state.code.trim()) return;
    setBusy(`${service}-code`);
    try {
      const result = await coreFetch<EmailLoginResult>(
        `/integrations/${service}/submit-login-code`,
        { method: 'POST', body: JSON.stringify({ code: state.code.trim() }) },
      );
      const shot = result.screenshot?.image_base64
        ? `data:${result.screenshot.mime_type};base64,${result.screenshot.image_base64}`
        : null;
      setState((prev) => ({
        ...prev,
        result,
        shot,
        code: '',
        step: result.ok ? 'done' : 'error',
      }));
      toast(result.text, result.ok ? 'success' : 'error');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function verifySession(
    service: 'uber' | 'rappi',
    setState: React.Dispatch<React.SetStateAction<EmailLoginState>>,
  ) {
    setBusy(`${service}-verify`);
    setState((prev) => ({ ...prev, result: null, shot: null }));
    try {
      const result = await coreFetch<any>(`/integrations/${service}/start-session`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const shot = result.screenshot?.image_base64
        ? `data:${result.screenshot.mime_type};base64,${result.screenshot.image_base64}`
        : null;
      const ok = result.state === 'logged_in';
      setState((prev) => ({
        ...prev,
        result: {
          ok,
          reason: ok ? 'logged_in' : 'unknown',
          text: ok ? `Sesión verificada: activa` : `Sesión verificada: requiere iniciar sesión (${result.state})`,
        },
        shot,
        step: ok ? 'done' : 'error',
      }));
      toast(ok ? 'Sesión activa' : 'Sesión inactiva o requiere iniciar sesión', ok ? 'success' : 'info');
    } catch (error) {
      toast((error as Error).message, 'error');
      setState((prev) => ({ ...prev, step: 'error' }));
    } finally {
      setBusy(null);
    }
  }

  // ── Simple token providers ────────────────────────────────────────────────

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
      setIntegrations((prev) => prev.filter((i) => i.provider !== provider));
      if (provider === 'google') setGoogleAccount(null);
      toast(`${provider} credential removed`, 'info');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

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
              onChange={(e) => setGoogle((prev) => ({ ...prev, client_id: e.target.value }))}
              placeholder="Client ID — …apps.googleusercontent.com"
              className={inputClass}
            />
            <input
              aria-label="Google client secret"
              type="password"
              autoComplete="off"
              value={google.client_secret}
              onChange={(e) => setGoogle((prev) => ({ ...prev, client_secret: e.target.value }))}
              placeholder="Client secret — GOCSPX-…"
              className={inputClass}
            />
            <input
              aria-label="Google refresh token"
              type="password"
              autoComplete="off"
              value={google.refresh_token}
              onChange={(e) => setGoogle((prev) => ({ ...prev, refresh_token: e.target.value }))}
              placeholder="Refresh token — 1//…"
              className={inputClass}
            />
          </div>

          {googleAccount && (
            <div className="border border-emerald-500/40 bg-emerald-500/5 rounded-sm p-3 space-y-2 animate-slide-up">
              <p className="text-xs font-mono text-emerald-400">Conectado como {googleAccount.email}</p>
              <div className="flex flex-wrap gap-1.5">
                {([
                  { key: 'gmail',    label: 'Gmail',    icon: Mail },
                  { key: 'calendar', label: 'Calendar', icon: Calendar },
                  { key: 'drive',    label: 'Drive',    icon: HardDrive },
                ] as const).map(({ key, label, icon: Icon }) => {
                  const svc = googleAccount.services[key];
                  return (
                    <span
                      key={key}
                      title={svc.ok ? `${label}: acceso confirmado` : `${label}: ${svc.error ?? 'sin acceso'}`}
                      className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-sm border font-mono ${
                        svc.ok
                          ? 'border-emerald-500/40 text-emerald-400'
                          : 'border-red-500/40 text-red-400'
                      }`}
                    >
                      <Icon className="w-3 h-3" />
                      {label} {svc.ok ? '✓' : '✗'}
                      {!svc.ok && svc.error && (
                        <span className="text-zinc-500 normal-case"> — {svc.error.slice(0, 40)}</span>
                      )}
                    </span>
                  );
                })}
              </div>
              <p className="text-[10px] font-mono text-zinc-600 break-all">
                scopes: {googleAccount.scopes.map((s) => s.split('/').pop()).join(', ') || '—'}
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
              Test Gmail · Calendar · Drive
            </Button>
            {googleIntegration && (
              <Button size="sm" variant="destructive" onClick={() => remove('google')} disabled={busy !== null}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* ── Google Web Login — cookie import ── */}
        <div className="border border-zinc-800 rounded-sm p-4 space-y-4 animate-fade-in">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-zinc-400" />
            <span className="text-sm text-zinc-100 font-medium">Google Web Login</span>
            <Badge variant="running">BROWSER</Badge>
            {googleWebImportResult?.ok || googleWebResult?.ok
              ? <Badge variant="completed">sesión activa</Badge>
              : <Badge variant="cancelled">sin sesión</Badge>}
          </div>

          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Importa las cookies de tu sesión de Google para que EVA pueda usar &ldquo;Continuar con Google&rdquo; en Uber y otros servicios — sin guardar tu contraseña.
          </p>

          {/* Steps */}
          <ol className="space-y-2 text-[11px] text-zinc-400 list-none">
            <li className="flex items-start gap-2">
              <span className="text-[10px] font-mono bg-zinc-800 text-zinc-300 rounded-full w-4 h-4 flex items-center justify-center flex-shrink-0 mt-0.5">1</span>
              <span>Instala la extensión <strong className="text-zinc-300">Cookie-Editor</strong> en tu Chrome o Firefox local.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[10px] font-mono bg-zinc-800 text-zinc-300 rounded-full w-4 h-4 flex items-center justify-center flex-shrink-0 mt-0.5">2</span>
              <span>Ve a <code className="bg-zinc-900 px-1 rounded text-zinc-300">accounts.google.com</code>, inicia sesión, abre Cookie-Editor → <strong className="text-zinc-300">Export → Export as JSON</strong>.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-[10px] font-mono bg-zinc-800 text-zinc-300 rounded-full w-4 h-4 flex items-center justify-center flex-shrink-0 mt-0.5">3</span>
              <span>Pega el JSON abajo e importa. EVA lo encripta en el servidor — nunca lo devuelve al cliente.</span>
            </li>
          </ol>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wide text-zinc-500">Cookies JSON</label>
            <textarea
              aria-label="Google cookies JSON"
              value={googleWebCookies}
              onChange={(e) => setGoogleWebCookies(e.target.value)}
              placeholder={'[{"name":"SID","value":"...","domain":".google.com",...}, ...]'}
              rows={5}
              className={cn(inputClass, 'resize-none font-mono text-[10px] leading-relaxed')}
            />
          </div>

          {/* Import result */}
          {googleWebImportResult && (
            <div className={cn(
              'flex items-start gap-2 text-xs font-mono rounded-sm border px-3 py-2',
              googleWebImportResult.ok
                ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
                : 'border-red-500/30 bg-red-500/5 text-red-400',
            )}>
              {googleWebImportResult.ok
                ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                : <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
              <span className="break-words">{googleWebImportResult.text}</span>
            </div>
          )}

          {/* Session test result */}
          {googleWebResult && (
            <div className={cn(
              'flex items-start gap-2 text-xs font-mono rounded-sm border px-3 py-2',
              googleWebResult.ok
                ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
                : 'border-amber-500/30 bg-amber-500/5 text-amber-300',
            )}>
              <ShieldCheck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span className="break-words">{googleWebResult.text}</span>
            </div>
          )}

          {googleWebShot && (
            <div className="inline-block border border-zinc-800 rounded-sm bg-zinc-950 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={googleWebShot} alt="Google Web session screenshot" className="w-[28rem] max-w-full h-auto" />
            </div>
          )}

          <div className="flex items-center gap-2 pt-1 border-t border-zinc-800">
            <Button
              size="sm"
              onClick={importGoogleSession}
              disabled={busy !== null || !googleWebCookies.trim()}
            >
              {busy === 'google-web-import'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Upload className="w-3.5 h-3.5" />}
              Importar sesión
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={testGoogleWebSession}
              disabled={busy !== null}
            >
              {busy === 'google-web-test'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <PlugZap className="w-3.5 h-3.5" />}
              Verificar sesión
            </Button>
          </div>
        </div>

        {/* ── Uber — email + OTP login ── */}
        <EmailLoginSection
          service="uber"
          label="Uber"
          icon={Car}
          blurb="Inicia sesión con tu correo para que EVA pueda abrir Uber Web, ver tarifas y solicitar viajes (con aprobación requerida). El código de verificación llega a tu correo o teléfono."
          capabilities={['Cotizar viajes', 'Pedir viaje (con aprobación)', 'Estado del viaje']}
          state={uberLogin}
          setState={setUberLogin}
          busy={busy}
          onStartEmailLogin={startEmailLogin}
          onSubmitCode={submitLoginCode}
          onVerifySession={verifySession}
          showPassword={true}
        />

        {/* ── Rappi — email + OTP login ── */}
        <EmailLoginSection
          service="rappi"
          label="Rappi"
          icon={UtensilsCrossed}
          blurb="Inicia sesión con tu correo para que EVA pueda hacer pedidos de comida y productos en Rappi (con aprobación requerida). El código de verificación llega a tu correo o teléfono."
          capabilities={['Ver menús y productos', 'Hacer pedido (con aprobación)', 'Estado del pedido']}
          state={rappiLogin}
          setState={setRappiLogin}
          busy={busy}
          onStartEmailLogin={startEmailLogin}
          onSubmitCode={submitLoginCode}
          onVerifySession={verifySession}
        />

        {/* ── Simple token providers ── */}
        {SIMPLE_PROVIDERS.map(({ provider, label, icon: Icon, blurb, capabilities, placeholder }) => {
          const current = integrations.find((i) => i.provider === provider);
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
                {capabilities.map((cap) => (
                  <span key={cap} className={cn(
                    'text-[10px] font-mono px-2 py-0.5 rounded-sm border',
                    current ? 'border-cyan-500/30 text-cyan-300' : 'border-zinc-800 text-zinc-600',
                  )}>
                    {cap}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  aria-label={`${label} token`}
                  value={drafts[provider] ?? ''}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [provider]: e.target.value }))}
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
