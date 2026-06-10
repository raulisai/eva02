import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { Topbar } from '@/components/layout/topbar';
import { SkillList } from '@/components/skills/skill-list';
import type { Skill, SkillTool } from '@/lib/types';

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
    .select('id,skill_id,name,capability,description,approval_level,enabled')
    .order('name');

  const toolsBySkill: Record<string, SkillTool[]> = {};
  ((tools ?? []) as SkillTool[]).forEach((tool) => {
    (toolsBySkill[tool.skill_id] ??= []).push(tool);
  });

  return (
    <>
      <Topbar title="Skills" subtitle={`${skills?.length ?? 0} skills · ${tools?.length ?? 0} tools`} />
      <div className="flex-1 min-h-0">
        <SkillList initialSkills={(skills ?? []) as Skill[]} toolsBySkill={toolsBySkill} />
      </div>
    </>
  );
}
