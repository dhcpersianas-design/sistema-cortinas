import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { usuarios } from '../db/schema.js';
import { conferirSenha, gerarHashSenha, HASH_FALSO, validarForcaSenha } from '../auth/senha.js';
import { COOKIE_SESSAO, criarSessao, encerrarSessao, encerrarSessoesDoUsuario } from '../auth/sessao.js';
import { permissoesDe } from '../auth/permissoes.js';
import { exigir } from '../auth/plugin.js';
import type { UsuarioSessao } from '../auth/sessao.js';

const corpoLogin = z.object({ email: z.string().trim().toLowerCase().email(), senha: z.string().min(1).max(200) });
const corpoTrocaSenha = z.object({ senhaAtual: z.string().min(1).max(200), novaSenha: z.string().max(200) });

export function usuarioPublico(u: UsuarioSessao) {
  return {
    id: u.id, nome: u.nome, email: u.email, perfil: u.perfil,
    podeVerCustos: u.perfil === 'ADMIN' || Boolean(u.podeVerCustos),
    descontoMaxPct: u.descontoMaxPct, deveTrocarSenha: u.deveTrocarSenha,
    permissoes: [...permissoesDe(u)].sort(),
  };
}

export async function rotasAuth(app: FastifyInstance) {
  const opcoesCookie = (expira: Date) => ({
    path: '/', httpOnly: true, sameSite: 'lax' as const, secure: app.config.cookieSeguro, expires: expira,
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: app.config.limiteLoginPorMinuto, timeWindow: '1 minute' } },
  }, async (req, res) => {
    const corpo = corpoLogin.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: 'Informe e-mail e senha.' });
    const [u] = await app.db.select().from(usuarios).where(eq(usuarios.email, corpo.data.email));
    // Confere sempre (mesmo sem usuário) para não revelar quais e-mails existem.
    const ok = await conferirSenha(corpo.data.senha, u?.senhaHash ?? HASH_FALSO);
    if (!u || !ok || !u.ativo) return res.code(401).send({ erro: 'E-mail ou senha incorretos.' });

    const { token, expiraEm } = await criarSessao(app.db, u.id, app.config.sessaoDias, {
      ip: req.ip, userAgent: req.headers['user-agent'],
    });
    await app.db.update(usuarios).set({ ultimoLoginEm: new Date() }).where(eq(usuarios.id, u.id));
    res.setCookie(COOKIE_SESSAO, token, opcoesCookie(expiraEm));
    return { usuario: usuarioPublico({ ...u, perfil: u.perfil }) };
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = req.cookies[COOKIE_SESSAO];
    if (token) await encerrarSessao(app.db, token);
    res.clearCookie(COOKIE_SESSAO, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/eu', { preHandler: exigir() }, async (req) => ({ usuario: usuarioPublico(req.usuario!) }));

  app.post('/api/auth/trocar-senha', { preHandler: exigir() }, async (req, res) => {
    const corpo = corpoTrocaSenha.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: 'Informe a senha atual e a nova.' });
    const fraca = validarForcaSenha(corpo.data.novaSenha);
    if (fraca) return res.code(400).send({ erro: fraca });
    const [u] = await app.db.select().from(usuarios).where(eq(usuarios.id, req.usuario!.id));
    if (!u || !(await conferirSenha(corpo.data.senhaAtual, u.senhaHash))) {
      return res.code(400).send({ erro: 'Senha atual incorreta.' });
    }
    await app.db.update(usuarios)
      .set({ senhaHash: await gerarHashSenha(corpo.data.novaSenha), deveTrocarSenha: false })
      .where(eq(usuarios.id, u.id));
    // Derruba os outros aparelhos; mantém o atual.
    await encerrarSessoesDoUsuario(app.db, u.id, req.cookies[COOKIE_SESSAO]);
    return { ok: true };
  });
}
