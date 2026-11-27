import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ErroEntrada } from '@sistema/motor-calculo';
import type { Config } from './config.js';
import { conectar, type Banco } from './db/conexao.js';
import { pluginAutenticacao } from './auth/plugin.js';
import { rotasAuth } from './rotas/auth.js';
import { rotasUsuarios } from './rotas/usuarios.js';
import { rotasCatalogo } from './rotas/catalogo.js';
import { rotasCalculo } from './rotas/calculo.js';
import { rotasClientes } from './rotas/clientes.js';
import { rotasFornecedores } from './rotas/fornecedores.js';
import { rotasOrcamentos } from './rotas/orcamentos.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Banco;
    config: Config;
  }
}

export async function criarApp(config: Config, opcoes: { log?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opcoes.log ?? true, trustProxy: true });
  const { pool, db } = conectar(config.databaseUrl);
  app.decorate('db', db);
  app.decorate('config', config);
  app.addHook('onClose', async () => { await pool.end(); });

  app.setErrorHandler((erro, _req, res) => {
    if (erro instanceof ErroEntrada) return res.code(400).send({ erro: erro.message });
    const status = (erro as { statusCode?: number }).statusCode;
    if (status === 429) return res.code(429).send({ erro: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
    if (status && status < 500) return res.code(status).send({ erro: (erro as Error).message });
    app.log.error(erro);
    return res.code(500).send({ erro: 'Erro interno.' });
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(pluginAutenticacao);

  app.get('/api/saude', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });
  await app.register(rotasAuth);
  await app.register(rotasUsuarios);
  await app.register(rotasCatalogo);
  await app.register(rotasCalculo);
  await app.register(rotasClientes);
  await app.register(rotasFornecedores);
  await app.register(rotasOrcamentos);
  return app;
}
