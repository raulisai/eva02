'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import { io, type Socket } from 'socket.io-client';
import '@xterm/xterm/css/xterm.css';

interface AgentTerminalProps {
  taskId: string | null;
  orgToken: string;
  onClose?: () => void;
}

export function AgentTerminal({ taskId, orgToken, onClose }: AgentTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'no_session' | 'error'>('connecting');
  const [fullscreen, setFullscreen] = useState(false);

  const attach = useCallback((socket: Socket, tid: string) => {
    socket.emit('sandbox.attach', { taskId: tid, shellNum: 0 });
  }, []);

  useEffect(() => {
    if (!containerRef.current || !taskId) {
      setStatus('no_session');
      return;
    }

    // Init xterm
    const term = new XTerm({
      theme: {
        background: '#0a0a0f',
        foreground: '#e2e8f0',
        cursor: '#22d3ee',
        cursorAccent: '#0a0a0f',
        selectionBackground: '#1e40af66',
        black: '#1e293b',
        red: '#f87171',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#a78bfa',
        cyan: '#22d3ee',
        white: '#e2e8f0',
        brightBlack: '#334155',
        brightRed: '#fc8181',
        brightGreen: '#6ee7b7',
        brightYellow: '#fcd34d',
        brightBlue: '#93c5fd',
        brightMagenta: '#c4b5fd',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      // xterm manages its own gutters — don't add CSS padding on top
      scrollOnUserInput: true,
    });

    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(containerRef.current);
    fit.fit();

    xtermRef.current = term;
    fitRef.current = fit;

    // Connect Socket.IO
    const coreUrl = process.env.NEXT_PUBLIC_CORE_URL ?? 'http://localhost:3000';
    const socket = io(`${coreUrl}/eva`, {
      auth: { token: orgToken },
      transports: ['websocket'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      attach(socket, taskId);
    });

    socket.on('sandbox.attached', ({ taskId: tid }: { taskId: string }) => {
      setStatus('connected');
      term.write('\r\n\x1b[1;36m── EVA Sandbox Terminal ──\x1b[0m\r\n');
      // Tell the server the real terminal dimensions immediately after attach.
      const { cols, rows } = term;
      if (cols && rows) socket.emit('sandbox.resize', { taskId: tid, cols, rows });
    });

    socket.on('sandbox.output', ({ data, initial }: { data: string; initial?: boolean }) => {
      // The server replays the full PTY buffer on every (re)attach. Repaint from a
      // clean screen instead of appending it on top of the stale history, otherwise
      // reconnecting piles up duplicated output and the view never overwrites itself.
      if (initial) term.reset();
      term.write(data);
    });

    socket.on('sandbox.error', ({ message }: { message: string }) => {
      setStatus('no_session');
      term.write(`\r\n\x1b[1;33m${message}\x1b[0m\r\n`);
    });

    socket.on('disconnect', () => {
      term.write('\r\n\x1b[1;31m[desconectado]\x1b[0m\r\n');
    });

    // Forward keystrokes to sandbox
    const disposeKey = term.onData((data) => {
      if (socket.connected) {
        socket.emit('sandbox.input', { taskId, data, shellNum: 0 });
      }
    });

    // Emit resize after xterm finishes fitting so the server shell matches.
    const emitResize = () => {
      const { cols, rows } = term;
      if (socketRef.current?.connected && taskId && cols && rows) {
        socketRef.current.emit('sandbox.resize', { taskId, cols, rows });
      }
    };

    // Resize observer — refit on container resize and notify the server.
    const ro = new ResizeObserver(() => { fit.fit(); emitResize(); });
    ro.observe(containerRef.current);

    return () => {
      disposeKey.dispose();
      ro.disconnect();
      socket.emit('sandbox.detach');
      socket.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
    };
  }, [taskId, orgToken, attach]);

  function reconnect() {
    if (!socketRef.current || !taskId) return;
    setStatus('connecting');
    // Clear the view up front so a re-attach never stacks on top of the old screen,
    // even if the server has no buffer to replay.
    xtermRef.current?.reset();
    attach(socketRef.current, taskId);
  }

  return (
    <div className={`flex flex-col bg-[#0a0a0f] rounded-xl overflow-hidden border border-slate-700 ${
      fullscreen ? 'fixed inset-4 z-50' : 'h-[22rem] min-h-0'
    }`}>
      {/* Terminal toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-900 border-b border-slate-700 shrink-0">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <div className="w-3 h-3 rounded-full bg-amber-400" />
          <div className="w-3 h-3 rounded-full bg-green-400" />
        </div>
        <span className="flex-1 text-center text-xs text-slate-500 font-mono">
          {taskId ? `sandbox · ${taskId.slice(0, 8)}…` : 'no session'}
        </span>
        {status === 'connecting' && (
          <span className="text-xs text-amber-400 animate-pulse">conectando…</span>
        )}
        {status === 'connected' && (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            live
          </span>
        )}
        {status === 'no_session' && (
          <span className="text-xs text-slate-500">sin sesión activa</span>
        )}
        <div className="flex items-center gap-1">
          <button onClick={reconnect} className="p-1 text-slate-500 hover:text-slate-300" title="Reconectar">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => setFullscreen((f) => !f)} className="p-1 text-slate-500 hover:text-slate-300">
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          {onClose && (
            <button onClick={onClose} className="p-1 text-slate-500 hover:text-red-400">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* xterm container — no padding: xterm manages its own gutters via terminalOptions */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}
