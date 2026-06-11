import type { Metadata } from 'next';
import Link from 'next/link';
import { Package, ExternalLink } from 'lucide-react';
import { requireOrgContext } from '@/lib/supabase/org';
import { Topbar } from '@/components/layout/topbar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { shortId } from '@/lib/utils';
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
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          {rows.length === 0 && (
            <div className="h-56 flex items-center justify-center text-xs font-mono text-zinc-600">
              No artifacts yet — task outputs will appear here
            </div>
          )}

          {rows.map((artifact) => (
            <div key={artifact.id} className="flex items-start gap-3 px-4 py-3 border-b border-zinc-800/70">
              <Package className="w-4 h-4 text-zinc-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-100 font-medium">{artifact.title}</span>
                  <Badge>{artifact.kind}</Badge>
                  {artifact.task_id && (
                    <Link
                      href={`/tasks/${artifact.task_id}`}
                      className="text-[10px] font-mono text-cyan-400 hover:underline inline-flex items-center gap-1"
                    >
                      task {shortId(artifact.task_id)}
                      <ExternalLink className="w-2.5 h-2.5" />
                    </Link>
                  )}
                </div>
                {artifact.content && (
                  <pre className="mt-2 text-[11px] font-mono text-zinc-400 bg-zinc-900/60 border border-zinc-800 rounded-sm p-3 max-h-40 overflow-auto whitespace-pre-wrap">
                    {artifact.content.slice(0, 2000)}
                  </pre>
                )}
                {artifact.uri && (
                  <a href={artifact.uri} target="_blank" rel="noopener noreferrer" className="text-[11px] font-mono text-cyan-400 hover:underline break-all">
                    {artifact.uri}
                  </a>
                )}
              </div>
              <span className="text-[10px] font-mono text-zinc-600 flex-shrink-0">
                {new Date(artifact.created_at).toLocaleString()}
              </span>
            </div>
          ))}
        </ScrollArea>
      </div>
    </>
  );
}
