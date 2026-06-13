import type { Metadata } from 'next';
import Link from 'next/link';
import { Package, ExternalLink } from 'lucide-react';
import { requireOrgContext } from '@/lib/supabase/org';
import { Topbar } from '@/components/layout/topbar';
import { ArtifactList } from '@/components/artifacts/artifact-list';
import type { Artifact } from '@/lib/types';

export const metadata: Metadata = { title: 'Artifacts' };
export const dynamic = 'force-dynamic';

export default async function ArtifactsPage() {
  const { supabase, orgId } = await requireOrgContext();
  const { data: artifacts } = await supabase
    .from('artifacts')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(100);

  const rows = (artifacts ?? []) as Artifact[];

  return (
    <>
      <Topbar title="Artifacts" subtitle={`${rows.length} produced by tasks`} />
      <ArtifactList initialArtifacts={rows} />
    </>
  );
}
