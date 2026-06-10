'use client';

import { useState } from 'react';
import { Plug, Plus, RefreshCw, Trash2, Loader2, Power } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { age, cn } from '@/lib/utils';
import { coreFetch } from '@/lib/core-api';
import type { McpConnection } from '@/lib/types';

const statusVariant: Record<McpConnection['status'], 'completed' | 'failed' | 'cancelled'> = {
  connected: 'completed',
  error: 'failed',
  disconnected: 'cancelled',
};

interface McpClientProps {
  initialConnections: McpConnection[];
}

export function McpClient({ initialConnections }: McpClientProps) {
  const [connections, setConnections] = useState(initialConnections);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', transport: 'http' as const, endpoint: '', auth_token: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function patchLocal(updated: McpConnection) {
    setConnections((prev) => {
      const exists = prev.some((connection) => connection.id === updated.id);
      return exists
        ? prev.map((connection) => connection.id === updated.id ? updated : connection)
        : [...prev, updated];
    });
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
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
        <span className="text-xs text-zinc-500">
          Connect external tool servers. Auth tokens are stored encrypted and never returned.
        </span>
        <Button size="sm" onClick={() => setShowForm((value) => !value)}>
          <Plus className="w-3.5 h-3.5" />
          Add connection
        </Button>
      </div>

      {showForm && (
        <div className="px-4 py-3 border-b border-zinc-800 grid grid-cols-[1fr_110px_2fr_1fr_auto] gap-2">
          <input
            value={form.name}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="Name (e.g. github)"
            aria-label="Connection name"
            className="bg-zinc-900 border border-zinc-700 rounded-sm px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/60"
          />
          <select
            value={form.transport}
            onChange={(event) => setForm((prev) => ({ ...prev, transport: event.target.value as 'http' }))}
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
          <Button size="sm" onClick={create} disabled={busy !== null || !form.name || !form.endpoint}>
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
            <Button size="sm" variant="ghost" onClick={() => toggle(connection)} disabled={busy !== null}>
              <Power className="w-3 h-3" />
            </Button>
            <Button size="sm" variant="destructive" onClick={() => remove(connection.id)} disabled={busy !== null}>
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
