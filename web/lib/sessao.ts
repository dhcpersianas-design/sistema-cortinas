import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const API_URL = process.env.API_URL ?? 'http://localhost:3333';

export type Usuario = {
  id: string; nome: string; email: string; perfil: 'ADMIN' | 'VENDEDOR';
  podeVerCustos: boolean; descontoMaxPct: string | null; deveTrocarSenha: boolean; permissoes: string[];
};

/** GET na API a partir do servidor do Next, repassando o cookie de sessão. */
export async function apiServidor<T>(caminho: string): Promise<{ status: number; dados: T | null }> {
  const jar = await cookies();
  const sessao = jar.get('sessao');
  const r = await fetch(`${API_URL}${caminho}`, {
    headers: sessao ? { cookie: `sessao=${sessao.value}` } : {},
    cache: 'no-store',
  });
  return { status: r.status, dados: r.ok ? ((await r.json()) as T) : null };
}

export async function usuarioAtual(): Promise<Usuario | null> {
  const { dados } = await apiServidor<{ usuario: Usuario }>('/api/auth/eu');
  return dados?.usuario ?? null;
}

/** Exige login (e permissão, se informada). Redireciona quando não tem. */
export async function exigirUsuario(permissao?: string): Promise<Usuario> {
  const u = await usuarioAtual();
  if (!u) redirect('/login');
  if (permissao && !u.permissoes.includes(permissao)) redirect('/');
  return u;
}
