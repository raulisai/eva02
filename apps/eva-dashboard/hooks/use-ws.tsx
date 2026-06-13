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

const EVA_EVENT_STATUS: Record<string, TaskStatus | undefined> = {
  'task.started': 'running',
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.cancelled': 'cancelled',
  'task.waiting_approval': 'waiting_for_approval',
};

const EVA_EVENTS = [
  'task.created',
  'task.update',
  'task.started',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.waiting_approval',
  'task.say',
  'task.log',
  'task.step',
  'task.result',
  'task.media',
  'task.form_request',
  'task.setup_required',
  'approval.requested',
  'approval.resolved',
  'dev.task.created',
  'dev.task.updated',
  'dev.task.completed',
  'dev.task.failed',
  'browser.screenshot.created',
  'communication.message.received',
  'communication.message.sent',
  'communication.send.failed',
  'wear.fast_path.started',
  'wear.fast_path.completed',
  'wear.fast_path.fallback',
  'wear.token.created',
  'wear.token.expired',
];

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

    EVA_EVENTS.forEach((name) => {
      socket.on(name, (data: { taskId?: string; payload?: Record<string, unknown>; ts?: number }) => {
        const event: EvaEvent = {
          type: name,
          orgId: '',
          taskId: data.taskId,
          payload: data.payload ?? {},
          ts: data.ts ?? Date.now(),
        };
        setEvents(prev => [event, ...prev].slice(0, 500));
        const status = EVA_EVENT_STATUS[name];
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
