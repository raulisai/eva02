'use client';

import { useState } from 'react';
import { Puzzle, Power, Loader2, ChevronDown, FlaskConical, Wrench, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { coreFetch } from '@/lib/core-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import type { Skill, SkillTool, ToolRouteDecision } from '@/lib/types';

const statusVariant: Record<Skill['status'], 'completed' | 'cancelled' | 'pending' | 'failed'> = {
  active: 'completed',
  draft: 'pending',
  disabled: 'cancelled',
  archived: 'failed',
};

interface SkillListProps {
  initialSkills: Skill[];
  toolsBySkill: Record<string, SkillTool[]>;
}

export function SkillList({ initialSkills, toolsBySkill }: SkillListProps) {
  const { toast } = useToast();
  const [skills, setSkills] = useState(initialSkills);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ToolRouteDecision>>({});

  async function toggle(skill: Skill) {
    const next = skill.status === 'active' ? 'disabled' : 'active';
    setBusyId(skill.id);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('skills')
        .update({ status: next })
        .eq('id', skill.id)
        .eq('org_id', skill.org_id);
      if (error) throw error;
      setSkills((prev) => prev.map((entry) => entry.id === skill.id ? { ...entry, status: next } : entry));
      toast(`${skill.display_name} → ${next}`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function removeSkill(skill: Skill) {
    if (!confirm(`Are you sure you want to permanently delete the skill "${skill.display_name}"?`)) return;
    setBusyId(skill.id);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('skills')
        .delete()
        .eq('id', skill.id)
        .eq('org_id', skill.org_id);
      if (error) throw error;
      setSkills((prev) => prev.filter((entry) => entry.id !== skill.id));
      toast(`Deleted skill: ${skill.display_name}`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  /** Dry-run: ask the tool-router which engine would execute this tool's capability. */
  async function testTool(tool: SkillTool) {
    setBusyId(tool.id);
    try {
      const decision = await coreFetch<ToolRouteDecision>('/tool-router/route', {
        method: 'POST',
        body: JSON.stringify({ capability: tool.capability }),
      });
      setDecisions((prev) => ({ ...prev, [tool.id]: decision }));
      toast(`${tool.name} → routed to ${decision.tool.name}`, 'success');
    } catch (error) {
      toast(`No route for "${tool.capability}" — ${(error as Error).message}`, 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-3">
        {skills.length === 0 && (
          <div className="h-56 flex items-center justify-center text-xs font-mono text-zinc-600">
            No skills registered — run migration 017 to seed the built-in catalog
          </div>
        )}

        {skills.map((skill) => {
          const tools = toolsBySkill[skill.id] ?? [];
          const isOpen = openId === skill.id;
          return (
            <div
              key={skill.id}
              className={cn(
                'border rounded-sm transition-all animate-fade-in',
                isOpen ? 'border-cyan-500/40 bg-zinc-900/40' : 'border-zinc-800 hover:border-zinc-700',
              )}
            >
              {/* Header row */}
              <div
                onClick={() => setOpenId(isOpen ? null : skill.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer group"
                aria-expanded={isOpen}
              >
                <Puzzle className={cn('w-4 h-4 flex-shrink-0', skill.status === 'active' ? 'text-cyan-400' : 'text-zinc-600')} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-100 font-medium">{skill.display_name}</span>
                    <Badge variant={statusVariant[skill.status]}>{skill.status}</Badge>
                    
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 transition-all"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSkill(skill);
                      }}
                      disabled={busyId === skill.id}
                      title="Delete Skill"
                    >
                      {busyId === skill.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    </Button>

                    <span className="text-[10px] font-mono text-zinc-600">
                      {skill.slug} · v{skill.latest_version ?? '—'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500 truncate mt-0.5">{skill.description ?? 'No description'}</p>
                </div>
                <span className="text-[10px] font-mono text-zinc-500 flex items-center gap-1 flex-shrink-0">
                  <Wrench className="w-3 h-3" /> {tools.length} tools
                </span>

                <ChevronDown className={cn('w-4 h-4 text-zinc-500 transition-transform flex-shrink-0', isOpen && 'rotate-180')} />
              </div>

              {/* Expanded detail */}
              {isOpen && (
                <div className="border-t border-zinc-800 px-4 py-3 space-y-3 animate-expand-y overflow-hidden">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">Tools</p>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => toggle(skill)} disabled={busyId === skill.id}>
                        {busyId === skill.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Power className="w-3 h-3" />}
                        {skill.status === 'active' ? 'Disable skill' : 'Enable skill'}
                      </Button>
                    </div>
                  </div>

                  {tools.length === 0 && (
                    <p className="text-xs font-mono text-zinc-600">This skill has no tools registered.</p>
                  )}

                  {tools.map((tool) => {
                    const decision = decisions[tool.id];
                    return (
                      <div key={tool.id} className="border border-zinc-800/70 rounded-sm">
                        <div className="flex items-center gap-3 px-3 py-2">
                          <code className="text-[11px] font-mono text-cyan-300 w-44 flex-shrink-0 truncate">{tool.name}</code>
                          <Badge>{tool.capability}</Badge>
                          {tool.approval_level > 0 && <Badge variant="pending">L{tool.approval_level}</Badge>}
                          <span className="text-[11px] text-zinc-500 truncate flex-1">{tool.description}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => testTool(tool)}
                            disabled={busyId === tool.id || skill.status !== 'active'}
                            title="Dry-run: route this capability through the tool-router"
                          >
                            {busyId === tool.id
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <FlaskConical className="w-3 h-3" />}
                            Probar
                          </Button>
                        </div>
                        {decision && (
                          <div className="border-t border-zinc-800/70 bg-zinc-900/60 px-3 py-2 text-[10px] font-mono space-y-0.5 animate-slide-up">
                            <p className="text-emerald-400">
                              → {decision.tool.name} (score {decision.score.toFixed(3)})
                            </p>
                            <p className="text-zinc-500">{decision.tool.description}</p>
                            <p className="text-zinc-600">
                              cost/token {decision.tool.costPerToken} · latency ~{decision.tool.avgLatencyMs}ms
                              {decision.alternates.length > 0 && ` · alternates: ${decision.alternates.map((alt) => alt.name).join(', ')}`}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
