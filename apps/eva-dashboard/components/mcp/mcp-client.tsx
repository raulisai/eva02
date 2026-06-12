'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  Database,
  Github,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { age, cn } from '@/lib/utils';
import { coreFetch } from '@/lib/core-api';
import {
  MCP_CATALOG,
  MCP_CATALOG_FILTERS,
  type McpCatalogCategory,
  type McpCatalogItem,
} from '@/lib/mcp-catalog';
import type { McpConnection } from '@/lib/types';

const statusVariant: Record<McpConnection['status'], 'completed' | 'failed' | 'cancelled'> = {
  connected: 'completed',
  error: 'failed',
  disconnected: 'cancelled',
};

interface McpClientProps {
  initialConnections: McpConnection[];
}

const catalogIcon: Record<McpCatalogCategory, typeof Plug> = {
  core: Server,
  code: Github,
  web: Cloud,
  data: Database,
  productivity: Plug,
  ops: Server,
  commerce: KeyRound,
  sandbox: Cloud,
};

function normalizeEndpoint(endpoint: string) {
  return endpoint.trim().replace(/\/+$/, '').toLowerCase();
}

export function McpClient({ initialConnections }: McpClientProps) {
  const [connections, setConnections] = useState(initialConnections);
  const [showForm, setShowForm] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState<'all' | McpCatalogCategory>('all');
  const [form, setForm] = useState<{
    name: string;
    transport: McpConnection['transport'];
    endpoint: string;
    auth_token: string;
  }>({ name: '', transport: 'http', endpoint: '', auth_token: '' });
  const [catalogSecrets, setCatalogSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visibleCatalog = catalogFilter === 'all'
    ? MCP_CATALOG
    : MCP_CATALOG.filter((preset) => preset.category === catalogFilter);

  function patchLocal(updated: McpConnection) {
    setConnections((prev) => {
      const exists = prev.some((connection) => connection.id === updated.id);
      const next = exists
        ? prev.map((connection) => connection.id === updated.id ? updated : connection)
        : [...prev, updated];
      return [...next].sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  function findCatalogConnection(preset: McpCatalogItem) {
    return connections.find((connection) => (
      connection.name.trim().toLowerCase() === preset.name.toLowerCase()
        || (
          connection.transport === preset.transport
          && normalizeEndpoint(connection.endpoint) === normalizeEndpoint(preset.endpoint)
        )
    ));
  }

  async function create() {
    setBusy('create');
    setError(null);
    try {
      const created = await coreFetch<McpConnection>('/integrations/mcp/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          transport: form.transport,
          endpoint: form.endpoint,
          auth_token: form.auth_token || undefined,
        }),
      });
      patchLocal(created);
      setForm({ name: '', transport: 'http', endpoint: '', auth_token: '' });
      setShowForm(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function connectPreset(preset: McpCatalogItem) {
    setBusy(`catalog:${preset.id}`);
    setError(null);
    try {
      const authToken = catalogSecrets[preset.id]?.trim();
      const created = await coreFetch<McpConnection>('/integrations/mcp/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: preset.name,
          transport: preset.transport,
          endpoint: preset.endpoint,
          auth_token: authToken || undefined,
          enabled: true,
        }),
      });
      patchLocal(created);
      setCatalogSecrets((prev) => ({ ...prev, [preset.id]: '' }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function test(id: string) {
    setBusy(id);
    setError(null);
    try {
      patchLocal(await coreFetch<McpConnection>(`/integrations/mcp/connections/${id}/test`, { method: 'POST' }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function toggle(connection: McpConnection) {
    setBusy(connection.id);
    try {
      patchLocal(await coreFetch<McpConnection>(`/integrations/mcp/connections/${connection.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !connection.enabled }),
      }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await coreFetch(`/integrations/mcp/connections/${id}`, { method: 'DELETE' });
      setConnections((prev) => prev.filter((connection) => connection.id !== id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-zinc-800">
        <span className="text-xs text-zinc-500 min-w-0">
          Connect external tool servers. Auth tokens are stored encrypted and never returned.
        </span>
        <Button
          size="sm"
          onClick={() => setShowForm((value) => !value)}
          aria-label="Add custom MCP connection"
          className="flex-shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          Custom
        </Button>
      </div>

      <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-950/30">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-100">MCP repository</span>
              <Badge>bundled</Badge>
              <Badge>{MCP_CATALOG.length} presets</Badge>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              Curated servers that can be added to this org with one connection action.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            org-scoped via eva-core
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {MCP_CATALOG_FILTERS.map((filter) => (
            <Button
              key={filter.id}
              size="sm"
              variant={catalogFilter === filter.id ? 'default' : 'outline'}
              onClick={() => setCatalogFilter(filter.id)}
              aria-pressed={catalogFilter === filter.id}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        <div className="mt-3 max-h-[58vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
            {visibleCatalog.map((preset) => {
              const Icon = catalogIcon[preset.category] ?? Plug;
              const existing = findCatalogConnection(preset);
              const isBusy = busy === `catalog:${preset.id}`;
              const secretValue = catalogSecrets[preset.id] ?? '';

              return (
                <div
                  key={preset.id}
                  className={cn(
                    'min-h-[210px] rounded-sm border bg-zinc-950/70 p-3 transition-colors',
                    existing ? 'border-emerald-500/25' : 'border-zinc-800 hover:border-cyan-500/35',
                  )}
                >
                  <div className="flex items-start gap-2">
                    <div className={cn(
                      'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-sm border',
                      existing
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-zinc-700 bg-zinc-900 text-cyan-300',
                    )}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <h3 className="truncate text-xs font-semibold text-zinc-100">{preset.name}</h3>
                        {existing && <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge>{preset.transport}</Badge>
                        <Badge>{preset.category}</Badge>
                        <Badge variant={existing ? 'completed' : 'default'}>
                          {existing ? 'connected' : preset.authLabel}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  <p className="mt-3 min-h-[42px] text-[11px] leading-5 text-zinc-400">{preset.summary}</p>
                  <p className="mt-2 truncate text-[10px] font-mono text-zinc-600" title={preset.endpoint}>
                    {preset.endpoint}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-1">
                    {preset.tools.map((tool) => (
                      <span
                        key={tool}
                        className="rounded-sm border border-zinc-800 bg-zinc-900/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>

                  <div className="mt-3 flex items-center gap-1.5 text-[10px] text-zinc-500" title={preset.setupHint}>
                    <KeyRound className="h-3 w-3 text-zinc-600" />
                    <span className="truncate">{preset.approval}</span>
                  </div>

                  <div className="mt-3 flex gap-2">
                    {preset.secretLabel && !existing && (
                      <input
                        type="password"
                        autoComplete="off"
                        value={secretValue}
                        onChange={(event) => setCatalogSecrets((prev) => ({
                          ...prev,
                          [preset.id]: event.target.value,
                        }))}
                        placeholder={preset.secretPlaceholder}
                        aria-label={preset.secretLabel}
                        className="min-w-0 flex-1 bg-zinc-900 border border-zinc-700 rounded-sm px-2 py-1.5 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
                      />
                    )}
                    <Button
                      size="sm"
                      variant={existing ? 'outline' : 'default'}
                      onClick={() => connectPreset(preset)}
                      disabled={busy !== null || Boolean(existing)}
                      aria-label={existing ? `${preset.name} connected` : `Connect ${preset.name}`}
                      className="ml-auto"
                    >
                      {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                      {existing ? 'Connected' : 'Connect'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {showForm && (
        <div className="px-4 py-3 border-b border-zinc-800 grid grid-cols-1 gap-2 md:grid-cols-[1fr_110px_2fr_1fr_auto]">
          <input
            value={form.name}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="Name (e.g. github)"
            aria-label="Connection name"
            className="bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
          />
          <select
            value={form.transport}
            onChange={(event) => setForm((prev) => ({
              ...prev,
              transport: event.target.value as McpConnection['transport'],
            }))}
            aria-label="Transport"
            className="bg-zinc-900 border border-zinc-700 rounded-sm px-2 py-2 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500/60"
          >
            <option value="http">http</option>
            <option value="sse">sse</option>
            <option value="stdio">stdio</option>
          </select>
          <input
            value={form.endpoint}
            onChange={(event) => setForm((prev) => ({ ...prev, endpoint: event.target.value }))}
            placeholder="https://mcp.example.com/mcp (or command for stdio)"
            aria-label="Endpoint"
            className="bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
          />
          <input
            type="password"
            autoComplete="off"
            value={form.auth_token}
            onChange={(event) => setForm((prev) => ({ ...prev, auth_token: event.target.value }))}
            placeholder="Auth token (optional)"
            aria-label="Auth token"
            className="bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
          />
          <Button
            size="sm"
            onClick={create}
            disabled={busy !== null || !form.name || !form.endpoint}
            aria-label="Connect custom MCP"
          >
            {busy === 'create' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Connect
          </Button>
        </div>
      )}

      {error && (
        <p className="px-4 py-2 text-xs font-mono text-red-400 border-b border-zinc-800 break-all">{error}</p>
      )}

      <ScrollArea className="flex-1">
        {connections.length === 0 && (
          <div className="h-56 flex items-center justify-center text-xs font-mono text-zinc-600">
            No MCP servers connected
          </div>
        )}

        {connections.map((connection) => (
          <div key={connection.id} className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800/70">
            <Plug className={cn('w-4 h-4 flex-shrink-0', connection.enabled ? 'text-cyan-400' : 'text-zinc-600')} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-100 font-medium">{connection.name}</span>
                <Badge variant={statusVariant[connection.status]}>{connection.status}</Badge>
                <span className="text-[10px] font-mono text-zinc-600">{connection.transport}</span>
                {!connection.enabled && <Badge variant="cancelled">paused</Badge>}
              </div>
              <p className="text-[10px] font-mono text-zinc-600 truncate mt-0.5">{connection.endpoint}</p>
              {connection.last_error && (
                <p className="text-[10px] font-mono text-red-400/80 truncate">{connection.last_error}</p>
              )}
            </div>
            {connection.last_checked_at && (
              <span className="text-[10px] font-mono text-zinc-600">checked {age(connection.last_checked_at)} ago</span>
            )}
            <Button size="sm" variant="outline" onClick={() => test(connection.id)} disabled={busy !== null}>
              {busy === connection.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Test
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => toggle(connection)}
              disabled={busy !== null}
              aria-label={`${connection.enabled ? 'Pause' : 'Enable'} ${connection.name}`}
            >
              <Power className="w-3 h-3" />
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => remove(connection.id)}
              disabled={busy !== null}
              aria-label={`Delete ${connection.name}`}
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
