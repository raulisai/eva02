import type { Metadata } from 'next';
import { Topbar } from '@/components/layout/topbar';
import { EventFeed } from '@/components/events/event-feed';

export const metadata: Metadata = { title: 'Events' };

export default function EventsPage() {
  return (
    <>
      <Topbar title="Event Stream" subtitle="eva:events · Redis Streams" />
      <div className="flex-1 min-h-0">
        <EventFeed />
      </div>
    </>
  );
}
