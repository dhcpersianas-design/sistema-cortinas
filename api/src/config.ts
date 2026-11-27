export interface Config {
  databaseUrl: string;
  porta: number;
  sessaoDias: number;
  /** Cookie só via HTTPS (produção). */
  cookieSeguro: boolean;
  /** Tentativas de login por minuto por IP. */
  limiteLoginPorMinuto: number;
}

export function lerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL não definida (veja .env.example).');
  return {
    databaseUrl,
    porta: Number(env.API_PORTA ?? 3333),
    sessaoDias: Number(env.SESSAO_DIAS ?? 30),
    cookieSeguro: env.NODE_ENV === 'production',
    limiteLoginPorMinuto: Number(env.LIMITE_LOGIN_POR_MINUTO ?? 10),
  };
}
