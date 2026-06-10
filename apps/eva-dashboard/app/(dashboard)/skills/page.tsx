import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { Topbar } from '@/components/layout/topbar';
import { SkillList } from '@/components/skills/skill-list';
import type { Skill } from '@/lib/types';

export const metadata: Metadata = { title: 'Skills' };
export const dynamic = 'force-dynamic';

export default async function SkillsPage() {
  const supabase = createClient();
  const { data: skills } = await supabase
    .from('skills')
    .select('*')
    .order('display_name');

  const { data: tools } = await supabase
    .from('tools')
    .select('id,skill_id,name,capability,approval_level,enabled');

  const toolsBySkill: Record<string, number> = {};
  (tools ?? []).forEach((tool: { skill_id: string }) => {
    toolsBySkill[tool.skill_id] = (toolsBySkill[tool.skill_id] ?? 0) + 1;
  });

  return (
    <>
      <Topbar title="Skills" subtitle={`${skills?.length ?? 0} registered`} />
      <div className="flex-1 min-h-0">
        <SkillList initialSkills={(skills ?? []) as Skill[]} toolCounts={toolsBySkill} />
      </div>
    </>
  );
}
