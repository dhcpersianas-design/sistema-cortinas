import type { Metadata, Viewport } from 'next';
import './globals.css';
import { RegistrarSW } from '@/components/registrar-sw';

/**
 * Prévia de link (WhatsApp e outros): mostra a logo da DHC em vez de só o endereço do sistema
 * (Gabriel, 27/11/2026). A imagem precisa de endereço completo: vem de SITE_URL (ou do domínio de produção).
 */
const SITE = process.env.SITE_URL ?? 'https://sistema.dhcpersianas.com.br';
export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: 'DHC Persianas & Cortinas',
  description: 'Orçamentos, produção e gestão',
  openGraph: {
    title: 'DHC Persianas & Cortinas', description: 'Persianas e cortinas sob medida.', siteName: 'DHC Persianas & Cortinas',
    type: 'website', locale: 'pt_BR', images: [{ url: '/logo-dhc.png', width: 400, height: 120, alt: 'DHC Persianas & Cortinas' }],
  },
};
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
