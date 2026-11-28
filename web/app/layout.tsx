import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
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
  appleWebApp: { capable: true, title: 'DHC', statusBarStyle: 'default' },
  openGraph: {
    title: 'DHC Persianas & Cortinas', description: 'Persianas e cortinas sob medida.', siteName: 'DHC Persianas & Cortinas',
    type: 'website', locale: 'pt_BR', images: [{ url: '/logo-dhc.png', width: 400, height: 120, alt: 'DHC Persianas & Cortinas' }],
  },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0f1c' },
  ],
};

// Mesma fonte da proposta em PDF (arquivos locais: não depende de internet no build).
const montserrat = localFont({
  variable: '--fonte-montserrat',
  display: 'swap',
  src: [
    { path: './fontes/Montserrat-Regular.ttf', weight: '400' },
    { path: './fontes/Montserrat-Medium.ttf', weight: '500' },
    { path: './fontes/Montserrat-SemiBold.ttf', weight: '600' },
    { path: './fontes/Montserrat-Bold.ttf', weight: '700' },
  ],
});

/** Aplica o tema antes de desenhar a tela: escolha salva no aparelho ou, se não houver, a do sistema. */
const SCRIPT_TEMA = `(function(){try{var t=localStorage.getItem('tema');var d=t==='escuro'||(t!=='claro'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={montserrat.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SCRIPT_TEMA }} />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        {children}
        <RegistrarSW />
      </body>
    </html>
  );
}
