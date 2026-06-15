'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { devStudioApi } from '@/lib/dev-studio-api';
import type { DevSession } from '@/lib/dev-studio-types';
import { SessionDetail } from '@/components/dev-studio/session-detail';

export default function SessionPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [session, setSession] = useState<DevSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    devStudioApi.getSession(id).then(setSession).catch((e) => {
      setError(e?.message ?? 'No se encontró la sesión');
    });
  }, [id]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-red-500 text-sm">{error}</p>
        <button
          onClick={() => router.push('/dev-studio')}
          className="text-sm text-blue-600 hover:underline"
        >
          Volver a Dev Studio
        </button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Back link */}
      <div className="shrink-0 px-4 pt-4">
        <button
          onClick={() => router.push('/dev-studio')}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Dev Studio
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        <SessionDetail session={session} onUpdate={setSession} />
      </div>
    </div>
  );
}
