import type { Metadata, Viewport } from 'next';
import './globals.css';
import { RegistrarSW } from '@/components/registrar-sw';

export const metadata: Metadata = { title: 'Sistema Cortinas', description: 'Orçamentos, produção e gestão' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2f5b4b' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-dvh antialiased">
        {children}
        <RegistrarSW />
      </body>
    </html>
  );
}
