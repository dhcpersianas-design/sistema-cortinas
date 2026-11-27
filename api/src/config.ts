export interface Config {
  databaseUrl: string;
  porta: number;
  sessaoDias: number;
  /** Cookie só via HTTPS (produção). */
  cookieSeguro: boolean;
  /** Tentativas de login por minuto por IP. */
  limiteLoginPorMinuto: number;
  /** Pasta dos backups do banco. Sem ela, o backup fica desligado. */
  pastaBackups?: string;
  /** Quantos backups diários manter. */
  backupsManter?: number;
  /** Hora local (0-23) a partir da qual o backup diário roda. */
  backupHora?: number;
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
    pastaBackups: env.BACKUP_PASTA || undefined,
    backupsManter: Number(env.BACKUP_MANTER ?? 14),
    backupHora: Number(env.BACKUP_HORA ?? 3),
  };
}
