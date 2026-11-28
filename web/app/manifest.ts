import type { MetadataRoute } from 'next';

// PWA: permite instalar no celular do vendedor e abrir sem internet na obra.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'DHC Persianas & Cortinas',
    short_name: 'DHC',
    lang: 'pt-BR',
    start_url: '/',
    display: 'standalone',
    background_color: '#faf7f3',
    theme_color: '#ec5242',
    icons: [{ src: '/icone.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
