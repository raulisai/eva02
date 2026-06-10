import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      colors: {
        eva: {
          bg: '#09090b',
          surface: '#18181b',
          border: '#27272a',
          accent: '#22d3ee',
          'accent-dim': '#155e75',
        },
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        glow: {
          '0%, 100%': { boxShadow: '0 0 4px #22d3ee44' },
          '50%': { boxShadow: '0 0 12px #22d3ee88' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(12px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'expand-y': {
          from: { opacity: '0', maxHeight: '0' },
          to: { opacity: '1', maxHeight: '600px' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
        'slide-in': 'slide-in 0.2s ease-out',
        glow: 'glow 2s ease-in-out infinite',
        'slide-up': 'slide-up 0.2s ease-out',
        'expand-y': 'expand-y 0.25s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
