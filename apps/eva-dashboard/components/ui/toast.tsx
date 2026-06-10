'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  variant: ToastVariant;
  message: string;
}

const ToastContext = createContext<{ toast: (message: string, variant?: ToastVariant) => void }>({
  toast: () => {},
});

const ICONS: Record<ToastVariant, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((message: string, variant: ToastVariant = 'info') => {
    const id = nextId.current++;
    setItems((prev) => [...prev.slice(-3), { id, variant, message }]);
    setTimeout(() => dismiss(id), variant === 'error' ? 8000 : 4000);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80" role="status" aria-live="polite">
        {items.map((item) => {
          const Icon = ICONS[item.variant];
          return (
            <div
              key={item.id}
              className={cn(
                'animate-slide-up flex items-start gap-2 rounded-sm border px-3 py-2.5 text-xs font-mono shadow-lg backdrop-blur',
                item.variant === 'success' && 'border-emerald-500/40 bg-emerald-950/80 text-emerald-300',
                item.variant === 'error' && 'border-red-500/40 bg-red-950/80 text-red-300',
                item.variant === 'info' && 'border-cyan-500/40 bg-zinc-900/90 text-cyan-300',
              )}
            >
              <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span className="flex-1 break-words leading-relaxed">{item.message}</span>
              <button onClick={() => dismiss(item.id)} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
