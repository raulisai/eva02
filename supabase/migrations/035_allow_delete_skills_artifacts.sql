-- Allow authenticated users to manually delete skills and artifacts from the dashboard

GRANT DELETE ON skills TO authenticated;
GRANT DELETE ON artifacts TO authenticated;

DROP POLICY IF EXISTS "skills_delete" ON skills;
CREATE POLICY "skills_delete" ON skills
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));

DROP POLICY IF EXISTS "artifacts_delete" ON artifacts;
CREATE POLICY "artifacts_delete" ON artifacts
  FOR DELETE USING (org_id = ANY(public.user_org_ids()));
