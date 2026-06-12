'use client';

import { useState } from 'react';
import { Settings, Sliders, Shield, Activity, Save, Loader2, Play, Globe, MessageSquare, AlertCircle, HelpCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';

interface AgentClientProps {
  orgId: string;
  initialSettings: Record<string, any> | null;
  efficiency: Record<string, any> | null;
  defense: Record<string, any> | null;
  toolMetrics: Array<Record<string, any>>;
}

export function AgentClient({ orgId, initialSettings, efficiency, defense, toolMetrics }: AgentClientProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  // Settings states
  const [tokenCap, setTokenCap] = useState<number>(initialSettings?.token_cap_per_task ?? 0);
  const [toolRateLimit, setToolRateLimit] = useState<number>(initialSettings?.tool_rate_limit_per_minute ?? 0);
  const [allowlistText, setAllowlistText] = useState<string>((initialSettings?.sandbox_network_allowlist ?? []).join(', '));
  const [heartbeatEnabled, setHeartbeatEnabled] = useState<boolean>(initialSettings?.heartbeat_enabled ?? false);
  const [heartbeatHour, setHeartbeatHour] = useState<number>(initialSettings?.heartbeat_hour ?? 7);

  async function saveSettings() {
    setBusy(true);
    const supabase = createClient();
    
    // Clean and split allowlist
    const sandbox_network_allowlist = allowlistText
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    try {
      const { error } = await supabase
        .from('org_agent_settings')
        .upsert({
          org_id: orgId,
          token_cap_per_task: Number(tokenCap),
          tool_rate_limit_per_minute: Number(toolRateLimit),
          sandbox_network_allowlist,
          heartbeat_enabled: heartbeatEnabled,
          heartbeat_hour: Math.min(Math.max(Number(heartbeatHour), 0), 23),
          updated_at: new Date().toISOString(),
        });

      if (error) throw error;
      toast('Agent boundaries updated successfully', 'success');
    } catch (err) {
      toast(`Failed to update boundaries: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="max-w-5xl p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Settings Form Column */}
        <div className="md:col-span-2 space-y-6">
          
          {/* Card: Boundaries */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2 border-b border-zinc-800 pb-3">
              <Shield className="w-5 h-5 text-cyan-400" />
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Autonomy & Limits</h3>
                <p className="text-xs text-zinc-500">Define guardrails to prevent infinite loops or cost overruns.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs text-zinc-400 font-medium flex items-center gap-1.5" htmlFor="token-cap-input">
                  Token Cap per Task
                  <span className="text-[10px] text-zinc-600">(0 = unlimited)</span>
                </label>
                <input
                  id="token-cap-input"
                  type="number"
                  value={tokenCap}
                  onChange={(e) => setTokenCap(Math.max(0, parseInt(e.target.value) || 0))}
                  placeholder="e.g. 50000"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500/60"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-zinc-400 font-medium flex items-center gap-1.5" htmlFor="tool-rate-limit-input">
                  Tool Calls / Minute
                  <span className="text-[10px] text-zinc-600">(0 = unlimited)</span>
                </label>
                <input
                  id="tool-rate-limit-input"
                  type="number"
                  value={toolRateLimit}
                  onChange={(e) => setToolRateLimit(Math.max(0, parseInt(e.target.value) || 0))}
                  placeholder="e.g. 20"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500/60"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-zinc-400 font-medium flex items-center gap-1.5" htmlFor="sandbox-allowlist-input">
                Sandbox Network Allowlist
                <span className="text-[10px] text-zinc-600">(Comma separated domains)</span>
              </label>
              <textarea
                id="sandbox-allowlist-input"
                value={allowlistText}
                onChange={(e) => setAllowlistText(e.target.value)}
                placeholder="api.whatsapp.com, api.uber.com, github.com"
                rows={2}
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500/60 font-mono resize-none"
              />
            </div>
          </div>

          {/* Card: Autonomy Tick & Heartbeat */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2 border-b border-zinc-800 pb-3">
              <Sliders className="w-5 h-5 text-indigo-400" />
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Daily Heartbeat Flywheel</h3>
                <p className="text-xs text-zinc-500">Wake up agent daily to review schedule, inbox and draft actions.</p>
              </div>
            </div>

            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <input
                  id="heartbeat-toggle"
                  type="checkbox"
                  checked={heartbeatEnabled}
                  onChange={(e) => setHeartbeatEnabled(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-zinc-700 bg-zinc-900 text-cyan-600 focus:ring-0 focus:ring-offset-0 focus:outline-none cursor-pointer"
                />
                <label htmlFor="heartbeat-toggle" className="text-xs text-zinc-300 font-medium cursor-pointer select-none">
                  Enable Daily Heartbeat
                </label>
              </div>

              {heartbeatEnabled && (
                <div className="flex items-center gap-2">
                  <label htmlFor="heartbeat-hour-input" className="text-xs text-zinc-400">Trigger Hour (0-23):</label>
                  <input
                    id="heartbeat-hour-input"
                    type="number"
                    min={0}
                    max={23}
                    value={heartbeatHour}
                    onChange={(e) => setHeartbeatHour(Math.min(23, Math.max(0, parseInt(e.target.value) || 0)))}
                    className="w-16 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 text-center focus:outline-none focus:border-cyan-500/60"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <Button onClick={saveSettings} disabled={busy} size="default" className="gap-2 bg-cyan-600 hover:bg-cyan-700 text-white font-medium text-xs rounded shadow">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save Configuration
            </Button>
          </div>

        </div>

        {/* Telemetry Column */}
        <div className="space-y-6">
          
          {/* Card: Autonomy Telemetry Summary */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2 border-b border-zinc-800 pb-3">
              <Activity className="w-5 h-5 text-emerald-400" />
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Autonomy Telemetry</h3>
                <p className="text-xs text-zinc-500">Live operational telemetry & stats</p>
              </div>
            </div>

            {efficiency ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-center">
                  <div className="bg-zinc-900/40 p-2.5 rounded border border-zinc-800/60">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Total Runs</p>
                    <p className="text-lg font-bold text-zinc-200 mt-0.5">{efficiency.runs}</p>
                  </div>
                  <div className="bg-zinc-900/40 p-2.5 rounded border border-zinc-800/60">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Avg Duration</p>
                    <p className="text-lg font-bold text-zinc-200 mt-0.5">{Math.round(efficiency.avg_duration_ms / 100) / 10}s</p>
                  </div>
                  <div className="bg-zinc-900/40 p-2.5 rounded border border-zinc-800/60">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Avg Steps / Run</p>
                    <p className="text-lg font-bold text-zinc-200 mt-0.5">{efficiency.avg_steps}</p>
                  </div>
                  <div className="bg-zinc-900/40 p-2.5 rounded border border-zinc-800/60">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Avg Tokens</p>
                    <p className="text-lg font-bold text-zinc-200 mt-0.5">{Math.round(efficiency.avg_tokens).toLocaleString()}</p>
                  </div>
                </div>

                <div className="bg-zinc-900/20 border border-zinc-800 rounded p-3 text-xs space-y-1.5">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">P95 Token usage:</span>
                    <span className="font-mono text-zinc-300">{(efficiency.p95_tokens ?? 0).toLocaleString()}</span>
                  </div>
                  {defense && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">Avg Stalls per run:</span>
                        <span className="font-mono text-zinc-300">{defense.stalls_per_run}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">DoD Rejections:</span>
                        <span className="font-mono text-zinc-300">{defense.dod_rejections}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-6">
                <AlertCircle className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
                <p className="text-xs text-zinc-500">No telemetry recorded yet.</p>
              </div>
            )}
          </div>

        </div>

        {/* Full Width Table: Tool Success Funnels */}
        <div className="md:col-span-3 bg-zinc-950 border border-zinc-800 rounded-lg p-5 space-y-4">
          <div className="border-b border-zinc-800 pb-3">
            <h3 className="text-sm font-semibold text-zinc-100">Tool Executions & Success Rates</h3>
            <p className="text-xs text-zinc-500">Statistics per individual agent tool call.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500 font-medium">
                  <th className="py-2.5 px-3">Tool Name</th>
                  <th className="py-2.5 px-3">Success Rate</th>
                  <th className="py-2.5 px-3">Runs</th>
                  <th className="py-2.5 px-3 text-right">Avg Steps</th>
                  <th className="py-2.5 px-3 text-right">Avg Tokens</th>
                  <th className="py-2.5 px-3 text-right">Avg Stalls</th>
                  <th className="py-2.5 px-3 text-right">DoD Rejections</th>
                </tr>
              </thead>
              <tbody>
                {toolMetrics.length > 0 ? (
                  toolMetrics.map((row) => (
                    <tr key={row.tool_name} className="border-b border-zinc-900 hover:bg-zinc-900/30 transition-colors">
                      <td className="py-2.5 px-3 font-mono text-cyan-400 font-medium">{row.tool_name}</td>
                      <td className="py-2.5 px-3">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          row.success_rate >= 0.9 ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/40' :
                          row.success_rate >= 0.7 ? 'bg-amber-950 text-amber-400 border border-amber-800/40' :
                          'bg-red-950 text-red-400 border border-red-800/40'
                        }`}>
                          {Math.round(row.success_rate * 1000) / 10}%
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-zinc-300 font-mono">{row.runs}</td>
                      <td className="py-2.5 px-3 text-right text-zinc-400 font-mono">{row.avg_steps}</td>
                      <td className="py-2.5 px-3 text-right text-zinc-400 font-mono">{Math.round(row.avg_tokens).toLocaleString()}</td>
                      <td className="py-2.5 px-3 text-right text-zinc-400 font-mono">{row.avg_stalls}</td>
                      <td className="py-2.5 px-3 text-right text-zinc-400 font-mono">{row.avg_dod_rejections}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-zinc-600">
                      No tool telemetry metrics available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </ScrollArea>
  );
}
