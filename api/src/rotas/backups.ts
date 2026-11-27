import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { exigir } from '../auth/plugin.js';
import { fazerBackup, listarBackups, PADRAO_BACKUP } from '../backup.js';

/** Backups do banco (só ADMIN). Desligado quando BACKUP_PASTA não está definida. */
export async function rotasBackups(app: FastifyInstance) {
  const pasta = app.config.pastaBackups;
  const desligado = { erro: 'Backup não configurado neste servidor (BACKUP_PASTA).' };

  app.get('/api/admin/backups', { preHandler: exigir('backups.gerenciar') }, async () => ({
    ativo: Boolean(pasta),
    manter: app.config.backupsManter ?? 14,
    backups: pasta ? listarBackups(pasta) : [],
  }));

  app.post('/api/admin/backups', {
    preHandler: exigir('backups.gerenciar'),
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (_req, res) => {
    if (!pasta) return res.code(409).send(desligado);
    try {
      return { backup: await fazerBackup(app.config.databaseUrl, pasta, app.config.backupsManter ?? 14) };
    } catch (e) {
      app.log.error(e);
      return res.code(500).send({ erro: 'Não foi possível gerar o backup. Veja os logs do servidor.' });
    }
  });

  app.get<{ Params: { arquivo: string } }>('/api/admin/backups/:arquivo', { preHandler: exigir('backups.gerenciar') }, async (req, res) => {
    if (!pasta) return res.code(409).send(desligado);
    const { arquivo } = req.params;
    // Só nomes no padrão exato: impede ler qualquer outro arquivo do servidor.
    if (!PADRAO_BACKUP.test(arquivo) || !listarBackups(pasta).some((b) => b.arquivo === arquivo)) {
      return res.code(404).send({ erro: 'Backup não encontrado.' });
    }
    res.header('content-type', 'application/octet-stream');
    res.header('content-disposition', `attachment; filename="${arquivo}"`);
    return res.send(createReadStream(join(pasta, arquivo)));
  });
}
