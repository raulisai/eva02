'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Watch, Loader2, Plus, KeySquare, Copy, ChevronDown,
  Bot, Globe, Image as ImageIcon, AppWindow, Settings2, Activity,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn, age } from '@/lib/utils';
import { coreFetch } from '@/lib/core-api';
import type { Integration, WearCommand, WearOverview } from '@/lib/types';

const CATEGORY_META: Record<WearCommand['category'], { label: string; icon: typeof Bot }> = {
  agent:   { label: 'Agent',   icon: Bot },
  web:     { label: 'Web',     icon: Globe },
  media:   { label: 'Media',   icon: ImageIcon },
  apps:    { label: 'Apps',    icon: AppWindow },
  system:  { label: 'System',  icon: Settings2 },
  sensors: { label: 'Sensors', icon: Activity },
};

interface WearChannelProps {
  onIntegrationChange: (integration: Integration) => void;
}

export function WearChannel({ onIntegrationChange }: WearChannelProps) {
  const { toast } = useToast();
  const [overview, setOverview] = useState<WearOverview | null>(null);
  const [enabledCommands, setEnabledCommands] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [pairing, setPairing] = useState<{ deviceId: string; sessionId: string; expiresAt: string } | null>(null);
  const [openExample, setOpenExample] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    coreFetch<WearOverview>('/integrations/channel/wear/overview')
      .then((data) => {
        if (cancelled) return;
        setOverview(data);
        setEnabledCommands(data.enabled_commands);
      })
      .catch((error) => toast(`wear overview: ${(error as Error).message}`, 'error'));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grouped = useMemo(() => {
    const byCategory = new Map<string, WearCommand[]>();
    overview?.commands.forEach((command) => {
      const list = byCategory.get(command.category) ?? [];
      list.push(command);
      byCategory.set(command.category, list);
    });
    return byCategory;
  }, [overview]);

  function toggleCommand(id: string) {
    setEnabledCommands((prev) => prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]);
  }

  async function saveCommands(status?: 'active' | 'disabled') {
    setBusy('save');
    try {
      const updated = await coreFetch<Integration>('/integrations/channel/wear', {
        method: 'PUT',
        body: JSON.stringify({
          config: { enabled_commands: enabledCommands },
          status: status ?? overview?.status ?? 'active',
        }),
      });
      onIntegrationChange(updated);
      setOverview((prev) => prev ? { ...prev, status: updated.status, enabled_commands: enabledCommands } : prev);
      toast('wearOS channel saved', 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function registerDevice() {
    setBusy('device');
    try {
      const device = await coreFetch<WearOverview['devices'][number]>('/integrations/channel/wear/devices', {
        method: 'POST',
        body: JSON.stringify({ label: deviceLabel }),
      });
      setOverview((prev) => prev ? { ...prev, status: 'active', devices: [device, ...prev.devices] } : prev);
      setDeviceLabel('');
      toast(`Device "${device.label}" registered — generate a pairing token`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function generatePairingToken(deviceId: string) {
    setBusy(deviceId);
    try {
      const token = await coreFetch<{ session_id: string; expires_at: string }>('/wear-fast-path/token', {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId }),
      });
      setPairing({ deviceId, sessionId: token.session_id, expiresAt: token.expires_at });
      toast('Pairing session created', 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text);
    toast('Copied to clipboard', 'info');
  }

  if (!overview) {
    return (
      <div className="flex items-center gap-2 text-xs font-mono text-zinc-600 p-6">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading wear overview…
      </div>
    );
  }

  const enabled = overview.status === 'active';

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <div className="flex items-center gap-3">
          <Watch className="w-5 h-5 text-cyan-400" />
          <h2 className="text-base font-semibold text-zinc-100">wearOS Watch</h2>
          <Badge variant="running">PRIMARY CHANNEL</Badge>
          <Badge variant={enabled ? 'completed' : 'cancelled'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
        </div>
        <p className="text-xs text-zinc-500 mt-1">
          The watch talks to EVA over the fast path and Socket.io; EVA answers with directives
          (notify, show image, open apps…). Everything below is the live contract for the watch app.
        </p>
      </div>

      {/* Devices + pairing */}
      <section className="space-y-3">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">Devices & pairing</h3>
        <div className="flex gap-2">
          <input
            value={deviceLabel}
            onChange={(event) => setDeviceLabel(event.target.value)}
            placeholder="Device label — e.g. Galaxy Watch 6 de Raúl"
            aria-label="Device label"
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
          />
          <Button size="sm" onClick={registerDevice} disabled={busy !== null || deviceLabel.trim().length < 2}>
            {busy === 'device' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Register device
          </Button>
        </div>

        {overview.devices.length === 0 && (
          <p className="text-xs font-mono text-zinc-600">No watch registered yet — this is step 1 for the watch app.</p>
        )}
        {overview.devices.map((device) => (
          <div key={device.id} className="flex items-center gap-3 border border-zinc-800 rounded-sm px-3 py-2 animate-fade-in">
            <span className={cn('led', device.status === 'pending_pairing' ? 'led-pending' : 'led-running')} />
            <span className="text-xs text-zinc-200 flex-1">{device.label ?? 'unnamed'}</span>
            <button
              onClick={() => copy(device.id)}
              className="font-mono text-[10px] text-zinc-500 hover:text-cyan-400 inline-flex items-center gap-1"
              title="Copy device_id"
            >
              {device.id.slice(0, 8)}… <Copy className="w-2.5 h-2.5" />
            </button>
            <span className="text-[10px] font-mono text-zinc-600">{age(device.created_at)} ago</span>
            <Button size="sm" variant="outline" onClick={() => generatePairingToken(device.id)} disabled={busy !== null}>
              {busy === device.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeySquare className="w-3 h-3" />}
              Pairing token
            </Button>
          </div>
        ))}

        {pairing && (
          <div className="border border-cyan-500/40 bg-cyan-500/5 rounded-sm p-3 space-y-1 animate-slide-up">
            <p className="text-[10px] font-mono uppercase tracking-widest text-cyan-400">Pairing session ready</p>
            <p className="text-xs font-mono text-zinc-300 flex items-center gap-2">
              session_id: {pairing.sessionId}
              <button onClick={() => copy(pairing.sessionId)} aria-label="Copy session id">
                <Copy className="w-3 h-3 text-zinc-500 hover:text-cyan-400" />
              </button>
            </p>
            <p className="text-[10px] font-mono text-zinc-500">
              expires {new Date(pairing.expiresAt).toLocaleString()} · the watch exchanges this for a realtime key
            </p>
          </div>
        )}
      </section>

      {/* Command catalog */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">
            Command catalog · {enabledCommands.length}/{overview.commands.length} enabled
          </h3>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => saveCommands()} disabled={busy !== null}>
              {busy === 'save' && <Loader2 className="w-3 h-3 animate-spin" />}
              Save commands
            </Button>
            <Button size="sm" variant="outline" onClick={() => saveCommands(enabled ? 'disabled' : 'active')} disabled={busy !== null}>
              {enabled ? 'Disable channel' : 'Enable channel'}
            </Button>
          </div>
        </div>

        {Array.from(grouped.entries()).map(([category, commands]) => {
          const meta = CATEGORY_META[category as WearCommand['category']];
          return (
            <div key={category} className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                <meta.icon className="w-3 h-3" /> {meta.label}
              </p>
              {commands.map((command) => {
                const isOn = enabledCommands.includes(command.id);
                const isOpen = openExample === command.id;
                return (
                  <div key={command.id} className="border border-zinc-800 rounded-sm">
                    <div className="flex items-center gap-3 px-3 py-2">
                      {/* Toggle */}
                      <button
                        role="switch"
                        aria-checked={isOn}
                        aria-label={`Toggle ${command.label}`}
                        onClick={() => toggleCommand(command.id)}
                        className={cn(
                          'relative w-8 h-4.5 h-[18px] rounded-full transition-colors flex-shrink-0',
                          isOn ? 'bg-cyan-500/70' : 'bg-zinc-700',
                        )}
                      >
                        <span className={cn(
                          'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-zinc-100 transition-transform',
                          isOn ? 'translate-x-[16px]' : 'translate-x-[2px]',
                        )} />
                      </button>
                      <code className="text-[11px] text-cyan-300 font-mono w-44 flex-shrink-0">{command.id}</code>
                      <span className="text-xs text-zinc-300 flex-shrink-0">{command.label}</span>
                      <span className="text-[11px] text-zinc-600 truncate flex-1">{command.description}</span>
                      <Badge variant={command.direction === 'watch_to_core' ? 'planning' : 'waiting'}>
                        {command.direction === 'watch_to_core' ? 'watch→core' : 'core→watch'}
                      </Badge>
                      {command.approval_level > 0 && <Badge variant="pending">L{command.approval_level}</Badge>}
                      <button
                        onClick={() => setOpenExample(isOpen ? null : command.id)}
                        aria-label={`Example for ${command.id}`}
                        className="text-zinc-500 hover:text-zinc-200"
                      >
                        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', isOpen && 'rotate-180')} />
                      </button>
                    </div>
                    {isOpen && (
                      <pre className="animate-expand-y overflow-hidden text-[10px] font-mono text-zinc-400 bg-zinc-900/70 border-t border-zinc-800 px-3 py-2 whitespace-pre-wrap">
                        {JSON.stringify(command.example, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </section>

      {/* Watch app contract */}
      <section className="space-y-2">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">Watch app — connection contract</h3>
        <div className="border border-zinc-800 rounded-sm divide-y divide-zinc-800">
          {Object.entries(overview.endpoints).map(([key, value]) => (
            <div key={key} className="flex items-center gap-3 px-3 py-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 w-24 flex-shrink-0">{key}</span>
              <code className="text-[11px] font-mono text-zinc-300 flex-1">{value}</code>
              <button onClick={() => copy(value)} aria-label={`Copy ${key}`}>
                <Copy className="w-3 h-3 text-zinc-600 hover:text-cyan-400" />
              </button>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-zinc-600 leading-relaxed">
          Flow for the watch app: 1) register device here → 2) POST /wear-fast-path/token with the device_id →
          3) open Socket.io /eva with the token → 4) send watch→core commands, render core→watch directives.
        </p>
      </section>
    </div>
  );
}
