import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { template: '%s — EVA', default: 'EVA Command Center' },
  description: 'EVA agentic platform dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
