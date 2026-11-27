import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar, SENHA } from './ajuda.js';

let pool: pg.Pool;
let app: FastifyInstance;
let idVendedor: string;

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN', podeVerCustos: true });
  idVendedor = await criarUsuario(pool, { email: 'vendedor@loja.com', perfil: 'VENDEDOR' });
  await criarUsuario(pool, { email: 'inativo@loja.com', perfil: 'VENDEDOR', ativo: false });
  app = await appTeste();
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('login', () => {
  it('entra com e-mail e senha e grava cookie httpOnly', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ADMIN@loja.com ', senha: SENHA } });
    expect(r.statusCode).toBe(200);
    expect(r.json().usuario).toMatchObject({ email: 'admin@loja.com', perfil: 'ADMIN', podeVerCustos: true });
    const c = r.cookies.find((x) => x.name === 'sessao')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    // Só o hash do token vai para o banco.
    const { rows } = await pool.query('SELECT id FROM sessoes');
    expect(rows.map((x) => x.id)).not.toContain(c.value);
  });

  it('recusa senha errada, e-mail inexistente e usuário inativo com a mesma mensagem', async () => {
    for (const payload of [
      { email: 'admin@loja.com', senha: 'errada123' },
      { email: 'ninguem@loja.com', senha: SENHA },
      { email: 'inativo@loja.com', senha: SENHA },
    ]) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(r.statusCode).toBe(401);
      expect(r.json().erro).toBe('E-mail ou senha incorretos.');
    }
  });

  it('sem login, rotas protegidas respondem 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/eu' });
    expect(r.statusCode).toBe(401);
  });

  it('logout invalida a sessão', async () => {
    const cookie = await entrar(app, 'vendedor@loja.com');
    expect((await app.inject({ method: 'GET', url: '/api/auth/eu', headers: { cookie } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect((await app.inject({ method: 'GET', url: '/api/auth/eu', headers: { cookie } })).statusCode).toBe(401);
  });

  it('bloqueia tentativas demais de login (força bruta)', async () => {
    const app2 = await appTeste(3);
    try {
      const codigos = [];
      for (let i = 0; i < 4; i++) {
        codigos.push((await app2.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@loja.com', senha: 'errada123' } })).statusCode);
      }
      expect(codigos).toEqual([401, 401, 401, 429]);
      const bloqueio = await app2.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@loja.com', senha: 'x' } });
      expect(bloqueio.json().erro).toMatch(/Muitas tentativas/);
    } finally {
      await app2.close();
    }
  });

  it('sessão expirada não vale', async () => {
    const cookie = await entrar(app, 'vendedor@loja.com');
    await pool.query(`UPDATE sessoes SET expira_em = NOW() - INTERVAL '1 minute'`);
    expect((await app.inject({ method: 'GET', url: '/api/auth/eu', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('perfis', () => {
  it('vendedor não acessa a gestão de equipe', async () => {
    const cookie = await entrar(app, 'vendedor@loja.com');
    const r = await app.inject({ method: 'GET', url: '/api/usuarios', headers: { cookie } });
    expect(r.statusCode).toBe(403);
  });

  it('/eu devolve as permissões do perfil', async () => {
    const cookie = await entrar(app, 'vendedor@loja.com');
    const u = (await app.inject({ method: 'GET', url: '/api/auth/eu', headers: { cookie } })).json().usuario;
    expect(u.perfil).toBe('VENDEDOR');
    expect(u.podeVerCustos).toBe(false);
    expect(u.permissoes).toContain('orcamentos.proprios');
    expect(u.permissoes).not.toContain('custos.ver');
    expect(u.permissoes).not.toContain('financeiro.gerenciar');
  });
});

describe('gestão de equipe (ADMIN)', () => {
  it('cria vendedor, que precisa trocar a senha no primeiro acesso', async () => {
    const admin = await entrar(app, 'admin@loja.com');
    const r = await app.inject({
      method: 'POST', url: '/api/usuarios', headers: { cookie: admin },
      payload: { nome: 'Ana Campo', email: 'ana@loja.com', senhaInicial: 'Inicial123', descontoMaxPct: '7,5' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().usuario).toMatchObject({ perfil: 'VENDEDOR', podeVerCustos: false, descontoMaxPct: '7.50', deveTrocarSenha: true });

    const ana = await entrar(app, 'ana@loja.com', 'Inicial123');
    expect((await app.inject({ method: 'GET', url: '/api/auth/eu', headers: { cookie: ana } })).json().usuario.deveTrocarSenha).toBe(true);
    const t = await app.inject({ method: 'POST', url: '/api/auth/trocar-senha', headers: { cookie: ana }, payload: { senhaAtual: 'Inicial123', novaSenha: 'NovaSenha9' } });
    expect(t.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/eu', headers: { cookie: ana } })).json().usuario.deveTrocarSenha).toBe(false);
    await entrar(app, 'ana@loja.com', 'NovaSenha9');
  });

  it('recusa senha fraca e e-mail repetido', async () => {
    const admin = await entrar(app, 'admin@loja.com');
    const fraca = await app.inject({ method: 'POST', url: '/api/usuarios', headers: { cookie: admin }, payload: { nome: 'X Y', email: 'x@loja.com', senhaInicial: '123' } });
    expect(fraca.statusCode).toBe(400);
    const rep = await app.inject({ method: 'POST', url: '/api/usuarios', headers: { cookie: admin }, payload: { nome: 'X Y', email: 'vendedor@loja.com', senhaInicial: 'Valida123' } });
    expect(rep.statusCode).toBe(409);
  });

  it('desativar vendedor derruba a sessão dele na hora', async () => {
    const admin = await entrar(app, 'admin@loja.com');
    const vend = await entrar(app, 'vendedor@loja.com');
    const r = await app.inject({ method: 'PATCH', url: `/api/usuarios/${idVendedor}`, headers: { cookie: admin }, payload: { ativo: false } });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/eu', headers: { cookie: vend } })).statusCode).toBe(401);
    expect(Number((await pool.query('SELECT COUNT(*) n FROM sessoes WHERE usuario_id = $1', [idVendedor])).rows[0].n)).toBe(0);
    await pool.query('UPDATE usuarios SET ativo = TRUE WHERE id = $1', [idVendedor]);
  });

  it('admin não pode se desativar nem se rebaixar', async () => {
    const admin = await entrar(app, 'admin@loja.com');
    const eu = (await app.inject({ method: 'GET', url: '/api/auth/eu', headers: { cookie: admin } })).json().usuario;
    for (const payload of [{ ativo: false }, { perfil: 'VENDEDOR' }]) {
      const r = await app.inject({ method: 'PATCH', url: `/api/usuarios/${eu.id}`, headers: { cookie: admin }, payload });
      expect(r.statusCode).toBe(400);
    }
  });
});
