'use client';

import { useMemo, useState } from 'react';
import {
  Send, MessageCircle, Slack, Phone, Mail, MessageSquareText, Watch,
  CheckCircle2, XCircle, Loader2, Webhook,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { coreFetch } from '@/lib/core-api';
import { WearChannel } from '@/components/settings/wear-channel';
import type { Integration } from '@/lib/types';

const CHANNELS = [
  { provider: 'wear',     label: 'wearOS Watch', icon: Watch,         ready: true,  blurb: 'Primary channel: the watch app talks to EVA in realtime.' },
  { provider: 'telegram', label: 'Telegram', icon: Send,              ready: true,  blurb: 'Run EVA from Telegram DMs and groups.' },
  { provider: 'discord',  label: 'Discord',  icon: MessageCircle,     ready: false, blurb: 'Discord bot integration.' },
  { provider: 'slack',    label: 'Slack',    icon: Slack,             ready: false, blurb: 'Slack app integration.' },
  { provider: 'whatsapp', label: 'WhatsApp', icon: Phone,             ready: true,  blurb: 'WhatsApp Web profile with QR login.' },
  { provider: 'email',    label: 'Email',    icon: Mail,              ready: false, blurb: 'Inbound + outbound email.' },
  { provider: 'sms',      label: 'SMS (Twilio)', icon: MessageSquareText, ready: false, blurb: 'SMS via Twilio.' },
];

interface ChannelsClientProps {
  initialIntegrations: Integration[];
}

interface WhatsAppSessionStatus {
  state: 'logged_in' | 'qr_required' | 'loading' | 'unknown';
  screenshot?: { image_base64: string; mime_type: string };
}

export function ChannelsClient({ initialIntegrations }: ChannelsClientProps) {
  const { toast } = useToast();
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [selected, setSelected] = useState('wear');
  const [botToken, setBotToken] = useState('');
  const [allowedIds, setAllowedIds] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [whatsAppQr, setWhatsAppQr] = useState<string | null>(null);

  const current = useMemo(
    () => integrations.find((integration) => integration.provider === selected),
    [integrations, selected],
  );
  const channel = CHANNELS.find((entry) => entry.provider === selected)!;
  const enabled = current?.status === 'active';
  const allowedValue = allowedIds ?? String(current?.config?.allowed_user_ids ?? '');

  function patchLocal(updated: Integration) {
    setIntegrations((prev) => {
      const exists = prev.some((integration) => integration.provider === updated.provider);
      return exists
        ? prev.map((integration) => integration.provider === updated.provider ? updated : integration)
        : [...prev, updated];
    });
  }

  async function save(status?: 'active' | 'disabled') {
    setBusy('save');
    setFeedback(null);
    try {
      const body: Record<string, unknown> = {
        config: { allowed_user_ids: allowedValue },
        status: status ?? (enabled ? 'active' : 'disabled'),
      };
      if (botToken.trim()) body.secret = botToken.trim();
      const updated = await coreFetch<Integration>(`/integrations/channel/${selected}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      patchLocal(updated);
      setBotToken('');
      setFeedback({ ok: true, text: 'Saved. Token stored encrypted (AES-256-GCM).' });
      toast(`${selected} channel saved`, 'success');
    } catch (error) {
      setFeedback({ ok: false, text: (error as Error).message });
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy('test');
    setFeedback(null);
    try {
      const result = await coreFetch<{ ok: boolean; bot?: string; error?: string }>(
        '/integrations/channel/telegram/test',
        { method: 'POST' },
      );
      setFeedback(result.ok
        ? { ok: true, text: `Connected as @${result.bot}` }
        : { ok: false, text: result.error ?? 'Token rejected' });
      toast(result.ok ? `Telegram OK — @${result.bot}` : result.error ?? 'Token rejected', result.ok ? 'success' : 'error');
    } catch (error) {
      setFeedback({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function registerWebhook() {
    setBusy('webhook');
    setFeedback(null);
    try {
      const result = await coreFetch<{ ok: boolean; url?: string; error?: string }>(
        '/integrations/channel/telegram/webhook',
        { method: 'POST' },
      );
      setFeedback(result.ok
        ? { ok: true, text: `Webhook registered: ${result.url}` }
        : { ok: false, text: result.error ?? 'setWebhook failed' });
    } catch (error) {
      setFeedback({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function startWhatsAppSession() {
    setBusy('whatsapp');
    setFeedback(null);
    setWhatsAppQr(null);
    try {
      const result = await coreFetch<WhatsAppSessionStatus>('/integrations/whatsapp/start-session', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (result.state === 'logged_in') {
        const refreshed = await coreFetch<Integration[]>('/integrations?kind=channel');
        setIntegrations(refreshed);
        setFeedback({ ok: true, text: 'WhatsApp Web is linked and ready.' });
        toast('WhatsApp Web ready', 'success');
        return;
      }
      if (result.screenshot?.image_base64) {
        setWhatsAppQr(`data:${result.screenshot.mime_type};base64,${result.screenshot.image_base64}`);
      }
      setFeedback({
        ok: result.state === 'qr_required',
        text: result.state === 'qr_required'
          ? 'Scan this QR with WhatsApp on your phone.'
          : 'WhatsApp Web is still loading. Try again in a few seconds.',
      });
    } catch (error) {
      setFeedback({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full">
      {/* Channel list */}
      <div className="w-56 flex-shrink-0 border-r border-zinc-800">
        <ScrollArea className="h-full">
          {CHANNELS.map(({ provider, label, icon: Icon, ready }) => {
            const integration = integrations.find((entry) => entry.provider === provider);
            const active = integration?.status === 'active';
            return (
              <button
                key={provider}
                onClick={() => { setSelected(provider); setFeedback(null); setAllowedIds(null); }}
                className={cn(
                  'w-full flex items-center gap-2.5 px-4 py-3 text-left text-xs border-b border-zinc-800/60 transition-colors',
                  selected === provider ? 'bg-zinc-800/70 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/30',
                )}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="flex-1">{label}</span>
                <span className={cn('led', active ? 'led-running' : 'led-failed')} />
                {!ready && <span className="text-[9px] font-mono text-zinc-600">soon</span>}
              </button>
            );
          })}
        </ScrollArea>
      </div>

      {/* Detail pane */}
      <ScrollArea className="flex-1">
        <div className="max-w-3xl p-6 space-y-6">
          {selected === 'wear' && <WearChannel onIntegrationChange={patchLocal} />}

          {selected !== 'wear' && (
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-base font-semibold text-zinc-100">{channel.label}</h2>
                <Badge variant={enabled ? 'completed' : 'cancelled'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
                {current?.secret_hint
                  ? <Badge variant="running">token {current.secret_hint}</Badge>
                  : <Badge variant="pending">Needs setup</Badge>}
              </div>
              <p className="text-xs text-zinc-500 mt-1">{channel.blurb}</p>
            </div>
          )}

          {selected !== 'wear' && !channel.ready && (
            <p className="text-xs font-mono text-zinc-600 border border-dashed border-zinc-800 rounded-sm p-4">
              This channel is not wired into eva-core yet. Telegram is the reference implementation.
            </p>
          )}

          {selected === 'telegram' && (
            <>
              <section className="space-y-2">
                <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">Get your credentials</h3>
                <p className="text-xs text-zinc-500 leading-relaxed">
                  In Telegram, talk to @BotFather, run /newbot, and copy the token it gives you.
                  Then grab your numeric user ID from @userinfobot.
                </p>
              </section>

              <section className="space-y-2">
                <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">Required</h3>
                <label className="block text-xs text-zinc-300" htmlFor="bot-token">Bot token</label>
                <p className="text-[11px] text-zinc-600">
                  Stored encrypted server-side; only the last 4 characters are ever shown again.
                </p>
                <input
                  id="bot-token"
                  type="password"
                  autoComplete="off"
                  value={botToken}
                  onChange={(event) => setBotToken(event.target.value)}
                  placeholder={current?.secret_hint ? `Saved (${current.secret_hint}) — paste to replace` : 'Paste Telegram bot token'}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
                />
              </section>

              <section className="space-y-2">
                <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">Recommended</h3>
                <label className="block text-xs text-zinc-300" htmlFor="allowed-ids">Allowed Telegram user IDs</label>
                <p className="text-[11px] text-zinc-600">
                  Comma-separated numeric IDs. Without this, anyone can DM your bot.
                </p>
                <input
                  id="allowed-ids"
                  value={allowedValue}
                  onChange={(event) => setAllowedIds(event.target.value)}
                  placeholder="123456789, 987654321"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
                />
              </section>

              {feedback && (
                <div className={cn(
                  'flex items-center gap-2 text-xs font-mono rounded-sm border px-3 py-2',
                  feedback.ok ? 'border-emerald-500/30 text-emerald-400' : 'border-red-500/30 text-red-400',
                )}>
                  {feedback.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                  <span className="break-all">{feedback.text}</span>
                </div>
              )}

              <div className="flex items-center gap-2 pt-2 border-t border-zinc-800">
                <Button size="sm" onClick={() => save()} disabled={busy !== null}>
                  {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Save changes
                </Button>
                <Button size="sm" variant="outline" onClick={() => save(enabled ? 'disabled' : 'active')} disabled={busy !== null}>
                  {enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button size="sm" variant="outline" onClick={testConnection} disabled={busy !== null || !(current?.has_secret ?? current?.secret_hint)}>
                  {busy === 'test' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Test connection
                </Button>
                <Button size="sm" variant="ghost" onClick={registerWebhook} disabled={busy !== null || !(current?.has_secret ?? current?.secret_hint)}>
                  <Webhook className="w-3.5 h-3.5" />
                  Register webhook
                </Button>
              </div>
            </>
          )}

          {selected === 'whatsapp' && (
            <>
              <section className="space-y-2">
                <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">WhatsApp Web</h3>
                <p className="text-xs text-zinc-500 leading-relaxed">
                  EVA opens Chromium with a local WhatsApp profile. Scan once; the session stays in that profile.
                </p>
              </section>

              {feedback && (
                <div className={cn(
                  'flex items-center gap-2 text-xs font-mono rounded-sm border px-3 py-2',
                  feedback.ok ? 'border-emerald-500/30 text-emerald-400' : 'border-red-500/30 text-red-400',
                )}>
                  {feedback.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                  <span className="break-all">{feedback.text}</span>
                </div>
              )}

              {whatsAppQr && (
                <div className="inline-block border border-zinc-800 rounded-sm bg-white p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={whatsAppQr} alt="WhatsApp Web QR" className="w-72 h-auto" />
                </div>
              )}

              <div className="flex items-center gap-2 pt-2 border-t border-zinc-800">
                <Button size="sm" onClick={startWhatsAppSession} disabled={busy !== null}>
                  {busy === 'whatsapp' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Connect WhatsApp Web
                </Button>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
