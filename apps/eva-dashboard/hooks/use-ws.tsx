'use client';

import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
// Static require so Jest module mocks work; bundlers handle this fine.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { io } = require('socket.io-client') as typeof import('socket.io-client');
import type { Socket } from 'socket.io-client';
import type { EvaEvent, TaskStatus } from '@/lib/types';

interface WsContextValue {
  connected: boolean;
  events: EvaEvent[];
  patchTaskStatus: (taskId: string, status: TaskStatus) => void;
  taskPatches: Record<string, TaskStatus>;
}

const WsContext = createContext<WsContextValue>({
  connected: false,
  events: [],
  patchTaskStatus: () => {},
  taskPatches: {},
});

export function WsProvider({ token, children }: { token: string; children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<EvaEvent[]>([]);
  const [taskPatches, setTaskPatches] = useState<Record<string, TaskStatus>>({});
  const socketRef = useRef<Socket | null>(null);

  const patchTaskStatus = useCallback((taskId: string, status: TaskStatus) => {
    setTaskPatches(prev => ({ ...prev, [taskId]: status }));
  }, []);

  useEffect(() => {
    if (!token) return;

    const coreUrl = process.env.NEXT_PUBLIC_EVA_CORE_URL ?? 'http://localhost:3000';

    const socket = io(`${coreUrl}/eva`, {
      auth: { token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      transports: ['websocket'],
    });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    const EVA_EVENTS: Array<{ name: string; status?: TaskStatus }> = [
      { name: 'task.created' },
      { name: 'task.update' },
      { name: 'task.started',          status: 'running' },
      { name: 'task.completed',        status: 'completed' },
      { name: 'task.failed',           status: 'failed' },
      { name: 'task.cancelled',        status: 'cancelled' },
      { name: 'task.waiting_approval', status: 'waiting_for_approval' },
      { name: 'task.say' },
      { name: 'task.log' },
      { name: 'task.result' },
      { name: 'task.media' },
      { name: 'task.form_request' },
      { name: 'task.setup_required' },
      { name: 'approval.requested' },
    ];

    EVA_EVENTS.forEach(({ name, status }) => {
      socket.on(name, (data: { taskId?: string; payload?: Record<string, unknown>; ts?: number }) => {
        const event: EvaEvent = {
          type: name,
          orgId: '',
          taskId: data.taskId,
          payload: data.payload ?? {},
          ts: data.ts ?? Date.now(),
        };
        setEvents(prev => [event, ...prev].slice(0, 500));
        if (status && data.taskId) patchTaskStatus(data.taskId, status);
      });
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, patchTaskStatus]);

  return (
    <WsContext.Provider value={{ connected, events, patchTaskStatus, taskPatches }}>
      {children}
    </WsContext.Provider>
  );
}

export function useWs() {
  return useContext(WsContext);
}

export function useTaskEvents(taskId: string): EvaEvent[] {
  const { events } = useWs();
  return events.filter(e => e.taskId === taskId);
}

export function useLiveStatus(taskId: string): TaskStatus | undefined {
  const { taskPatches } = useWs();
  return taskPatches[taskId];
}
