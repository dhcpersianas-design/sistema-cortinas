import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:3333';

const config: NextConfig = {
  // O navegador fala só com o Next; /api/* é repassado para a API (mesma origem,
  // então o cookie de sessão httpOnly funciona sem CORS).
  async rewrites() {
    return [{ source: '/api/:caminho*', destination: `${API_URL}/api/:caminho*` }];
  },
};

export default config;
