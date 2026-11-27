import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { criarApp } from '../src/app.js';
import { migrar } from '../src/db/migrar.js';
import { ARQUIVO_EXEMPLO } from '../src/scripts/carregar-exemplo.js';
import { gerarHashSenha } from '../src/auth/senha.js';

export const URL_TESTE = process.env.DATABASE_URL_TESTE ?? 'postgres://postgres@127.0.0.1:5432/cortinas_teste';
export const LOJA = '00000000-0000-0000-0000-000000000001';
export const SENHA = 'Senha123';

/** Zera o banco de teste, aplica as migrações e o catálogo de exemplo. */
export async function bancoLimpo(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: URL_TESTE });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrar(pool);
  await tirarTabelasFornecedores(pool);
  await pool.query(readFileSync(ARQUIVO_EXEMPLO, 'utf-8'));
  return pool;
}

/**
 * Os testes usam o catálogo fictício da especificação: tira os ~500 produtos reais que a
 * migração 0014 cadastra (tabelas do Armazém, Cortineiro e Slim), que só valem em produção.
 */
export async function tirarTabelasFornecedores(pool: pg.Pool) {
  const reais = `SELECT id FROM produtos WHERE sku ~ '^(ARM|COR|SLI)[A-Z]{3}-[0-9]{4}$'`;
  await pool.query(`DELETE FROM precos_barra_trilho WHERE produto_id IN (${reais})`);
  await pool.query(`DELETE FROM produtos WHERE id IN (${reais})`);
}

export async function criarUsuario(pool: pg.Pool, u: { email: string; perfil: 'ADMIN' | 'VENDEDOR'; podeVerCustos?: boolean; ativo?: boolean }) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO usuarios (loja_id, nome, email, senha_hash, perfil, pode_ver_custos, ativo)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [LOJA, u.email.split('@')[0], u.email, await gerarHashSenha(SENHA), u.perfil, u.podeVerCustos ?? false, u.ativo ?? true],
  );
  return rows[0]!.id;
}

export async function appTeste(limiteLoginPorMinuto = 1000, extra: { pastaBackups?: string; backupsManter?: number } = {}): Promise<FastifyInstance> {
  return criarApp({ databaseUrl: URL_TESTE, porta: 0, sessaoDias: 30, cookieSeguro: false, limiteLoginPorMinuto, ...extra }, { log: false });
}

/** Faz login e devolve o cabeçalho Cookie para as próximas chamadas. */
export async function entrar(app: FastifyInstance, email: string, senha = SENHA): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, senha } });
  if (r.statusCode !== 200) throw new Error(`login falhou (${r.statusCode}): ${r.body}`);
  const c = r.cookies.find((x) => x.name === 'sessao');
  return `sessao=${c!.value}`;
}
