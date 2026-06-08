import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function truncate(str: string, n = 8) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

export function shortId(uuid: string) {
  return uuid.slice(0, 8);
}

/** Milliseconds since epoch → human-readable age ("2m 34s", "1h 5m") */
export function age(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
