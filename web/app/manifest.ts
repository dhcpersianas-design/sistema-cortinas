import type { MetadataRoute } from 'next';

// PWA: permite instalar no celular do vendedor e abrir sem internet na obra.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sistema Cortinas',
    short_name: 'Cortinas',
    lang: 'pt-BR',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8f7f4',
    theme_color: '#2f5b4b',
    icons: [{ src: '/icone.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
