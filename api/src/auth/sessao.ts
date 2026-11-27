import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Banco } from '../db/conexao.js';
import { sessoes, usuarios } from '../db/schema.js';

export const COOKIE_SESSAO = 'sessao';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function criarSessao(
  db: Banco, usuarioId: string, dias: number, info: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; expiraEm: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiraEm = new Date(Date.now() + dias * 86_400_000);
  await db.insert(sessoes).values({
    id: hashToken(token), usuarioId, expiraEm,
    ip: info.ip?.slice(0, 64), userAgent: info.userAgent?.slice(0, 300),
  });
  return { token, expiraEm };
}

export type UsuarioSessao = {
  id: string; lojaId: string; nome: string; email: string;
  perfil: 'ADMIN' | 'VENDEDOR'; podeVerCustos: boolean | null; descontoMaxPct: string | null;
  deveTrocarSenha: boolean;
};

/** Devolve o usuário da sessão válida (não expirada, usuário ativo) e renova o prazo. */
export async function lerSessao(db: Banco, token: string, dias: number): Promise<UsuarioSessao | null> {
  const id = hashToken(token);
  const [linha] = await db
    .select({
      id: usuarios.id, lojaId: usuarios.lojaId, nome: usuarios.nome, email: usuarios.email,
      perfil: usuarios.perfil, podeVerCustos: usuarios.podeVerCustos, descontoMaxPct: usuarios.descontoMaxPct,
      deveTrocarSenha: usuarios.deveTrocarSenha, ultimoUsoEm: sessoes.ultimoUsoEm,
    })
    .from(sessoes)
    .innerJoin(usuarios, eq(usuarios.id, sessoes.usuarioId))
    .where(and(eq(sessoes.id, id), gt(sessoes.expiraEm, sql`NOW()`), eq(usuarios.ativo, true)));
  if (!linha) return null;
  // Renova no máximo 1x por hora para não escrever a cada requisição.
  if (Date.now() - linha.ultimoUsoEm.getTime() > 3_600_000) {
    await db.update(sessoes)
      .set({ ultimoUsoEm: new Date(), expiraEm: new Date(Date.now() + dias * 86_400_000) })
      .where(eq(sessoes.id, id));
  }
  const { ultimoUsoEm: _, ...usuario } = linha;
  return usuario;
}

export async function encerrarSessao(db: Banco, token: string): Promise<void> {
  await db.delete(sessoes).where(eq(sessoes.id, hashToken(token)));
}

export async function encerrarSessoesDoUsuario(db: Banco, usuarioId: string, excetoToken?: string): Promise<void> {
  const cond = excetoToken
    ? and(eq(sessoes.usuarioId, usuarioId), sql`${sessoes.id} <> ${hashToken(excetoToken)}`)
    : eq(sessoes.usuarioId, usuarioId);
  await db.delete(sessoes).where(cond);
}

export async function limparSessoesExpiradas(db: Banco): Promise<void> {
  await db.delete(sessoes).where(lt(sessoes.expiraEm, sql`NOW()`));
}
