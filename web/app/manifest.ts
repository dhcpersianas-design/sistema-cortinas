import type { MetadataRoute } from 'next';

// PWA: permite instalar no celular do vendedor e abrir sem internet na obra.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'DHC Persianas & Cortinas',
    short_name: 'DHC',
    lang: 'pt-BR',
    start_url: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#1f2937',
    icons: [{ src: '/icone.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
