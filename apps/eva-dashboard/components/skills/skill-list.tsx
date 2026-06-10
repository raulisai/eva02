'use client';

import { useState } from 'react';
import { Puzzle, Power, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Skill } from '@/lib/types';

const statusVariant: Record<Skill['status'], 'completed' | 'cancelled' | 'pending' | 'failed'> = {
  active: 'completed',
  draft: 'pending',
  disabled: 'cancelled',
  archived: 'failed',
};

interface SkillListProps {
  initialSkills: Skill[];
  toolCounts: Record<string, number>;
}

export function SkillList({ initialSkills, toolCounts }: SkillListProps) {
  const [skills, setSkills] = useState(initialSkills);
  const [busyId, setBusyId] = useState<string | null>(null);

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
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 grid gap-3 md:grid-cols-2">
        {skills.length === 0 && (
          <div className="col-span-2 h-56 flex items-center justify-center text-xs font-mono text-zinc-600">
            No skills registered — publish one via the skill-runtime package
          </div>
        )}

        {skills.map((skill) => (
          <div key={skill.id} className="border border-zinc-800 rounded-sm p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Puzzle className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-sm text-zinc-100 font-medium flex-1">{skill.display_name}</span>
              <Badge variant={statusVariant[skill.status]}>{skill.status}</Badge>
            </div>
            <p className="text-xs text-zinc-500 leading-relaxed min-h-8">
              {skill.description ?? 'No description'}
            </p>
            <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60">
              <span className="text-[10px] font-mono text-zinc-600">
                {skill.slug} · v{skill.latest_version ?? '—'} · {toolCounts[skill.id] ?? 0} tools
              </span>
              {(skill.status === 'active' || skill.status === 'disabled') && (
                <Button size="sm" variant="outline" onClick={() => toggle(skill)} disabled={busyId === skill.id}>
                  {busyId === skill.id
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Power className="w-3 h-3" />}
                  {skill.status === 'active' ? 'Disable' : 'Enable'}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
