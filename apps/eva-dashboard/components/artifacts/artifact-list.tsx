'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Package, ExternalLink, Trash2, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { shortId } from '@/lib/utils';
import type { Artifact } from '@/lib/types';

interface ArtifactListProps {
  initialArtifacts: Artifact[];
}

export function ArtifactList({ initialArtifacts }: ArtifactListProps) {
  const { toast } = useToast();
  const [artifacts, setArtifacts] = useState(initialArtifacts);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function removeArtifact(artifact: Artifact) {
    if (!confirm(`Are you sure you want to permanently delete the artifact "${artifact.title}"?`)) return;
    setBusyId(artifact.id);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('artifacts')
        .delete()
        .eq('id', artifact.id)
        .eq('org_id', artifact.org_id);
      if (error) throw error;
      setArtifacts((prev) => prev.filter((a) => a.id !== artifact.id));
      toast(`Deleted artifact: ${artifact.title}`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex-1 min-h-0">
      <ScrollArea className="h-full">
        {artifacts.length === 0 && (
          <div className="h-56 flex items-center justify-center text-xs font-mono text-zinc-600">
            No artifacts yet — task outputs will appear here
          </div>
        )}

        {artifacts.map((artifact) => (
          <div key={artifact.id} className="group flex items-start gap-3 px-4 py-3 border-b border-zinc-800/70 hover:bg-zinc-900/40 transition-colors">
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
                <a href={artifact.uri} target="_blank" rel="noopener noreferrer" className="text-[11px] font-mono text-cyan-400 hover:underline break-all block mt-1">
                  {artifact.uri}
                </a>
              )}
            </div>
            <div className="flex flex-col items-end gap-2 flex-shrink-0">
              <span className="text-[10px] font-mono text-zinc-600">
                {new Date(artifact.created_at).toLocaleString()}
              </span>
              <Button 
                size="icon" 
                variant="ghost" 
                className="h-6 w-6 opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 transition-all"
                onClick={() => removeArtifact(artifact)}
                disabled={busyId === artifact.id}
                title="Delete Artifact"
              >
                {busyId === artifact.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              </Button>
            </div>
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
