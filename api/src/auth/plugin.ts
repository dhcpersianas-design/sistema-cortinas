import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { COOKIE_SESSAO, lerSessao, type UsuarioSessao } from './sessao.js';
import { pode, type Permissao } from './permissoes.js';

declare module 'fastify' {
  interface FastifyRequest {
    usuario: UsuarioSessao | null;
  }
}

/** Lê o cookie de sessão em toda requisição e preenche `request.usuario`. */
export const pluginAutenticacao = fp(async (app: FastifyInstance) => {
  app.decorateRequest('usuario', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[COOKIE_SESSAO];
    req.usuario = token ? await lerSessao(app.db, token, app.config.sessaoDias) : null;
  });
});

/** preHandler: exige login e, opcionalmente, uma permissão. */
export function exigir(permissao?: Permissao) {
  return async (req: FastifyRequest, res: FastifyReply) => {
    if (!req.usuario) return res.code(401).send({ erro: 'Faça login para continuar.' });
    if (permissao && !pode(req.usuario, permissao)) {
      return res.code(403).send({ erro: 'Seu perfil não tem acesso a esta função.' });
    }
  };
}
