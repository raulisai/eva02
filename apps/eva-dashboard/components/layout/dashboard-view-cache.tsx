'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

const KEEP_ALIVE_ROUTES = new Set([
  '/tasks',
  '/nodes',
  '/events',
  '/logs',
  '/approvals',
  '/jobs',
  '/billing',
  '/playground',
  '/skills',
  '/mcp',
  '/artifacts',
  '/soul',
  '/settings/models',
  '/settings/channels',
  '/settings/credentials',
]);

function keepAliveKey(pathname: string | null): string | null {
  if (!pathname) return null;
  return KEEP_ALIVE_ROUTES.has(pathname) ? pathname : null;
}

function hasView(cache: Record<string, ReactNode>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(cache, key);
}

export function DashboardViewCache({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const activeKey = keepAliveKey(pathname);
  const [cache, setCache] = useState<Record<string, ReactNode>>(() =>
    activeKey ? { [activeKey]: children } : {},
  );
  const cached = activeKey ? hasView(cache, activeKey) : false;

  useEffect(() => {
    if (!activeKey || cached) return;
    setCache((prev) => (hasView(prev, activeKey) ? prev : { ...prev, [activeKey]: children }));
  }, [activeKey, cached, children]);

  const views = activeKey && !cached ? { ...cache, [activeKey]: children } : cache;

  return (
    <>
      {Object.entries(views).map(([key, view]) => (
        <section
          key={key}
          aria-hidden={key !== activeKey}
          className={key === activeKey ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}
          data-dashboard-view={key}
        >
          {view}
        </section>
      ))}
      {!activeKey && (
        <section className="flex-1 min-h-0 flex flex-col" data-dashboard-view="live">
          {children}
        </section>
      )}
    </>
  );
}
