import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt nativo do Node (sem dependência nativa). Parâmetros: N=2^15, r=8, p=1.
const N = 32768, R = 8, P = 1, TAM = 64;
const MAXMEM = 64 * 1024 * 1024;

function derivar(senha: string, sal: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opcoes: ScryptOptions = { N: n, r, p, maxmem: MAXMEM };
  return new Promise((ok, erro) => scrypt(senha.normalize('NFKC'), sal, TAM, opcoes, (e, chave) => (e ? erro(e) : ok(chave))));
}

/** Formato guardado: scrypt$N$r$p$salBase64$hashBase64 */
export async function gerarHashSenha(senha: string): Promise<string> {
  const sal = randomBytes(16);
  const hash = await derivar(senha, sal, N, R, P);
  return ['scrypt', N, R, P, sal.toString('base64'), hash.toString('base64')].join('$');
}

export async function conferirSenha(senha: string, guardado: string): Promise<boolean> {
  const partes = guardado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, n, r, p, sal, hash] = partes as [string, string, string, string, string, string];
  const esperado = Buffer.from(hash, 'base64');
  const obtido = await derivar(senha, Buffer.from(sal, 'base64'), Number(n), Number(r), Number(p));
  return esperado.length === obtido.length && timingSafeEqual(esperado, obtido);
}

export const SENHA_MIN = 8;

/** Regra mínima: 8+ caracteres com letra e número. Devolve a mensagem de erro ou null. */
export function validarForcaSenha(senha: string): string | null {
  if (senha.length < SENHA_MIN) return `A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`;
  if (!/[A-Za-z]/.test(senha) || !/\d/.test(senha)) return 'A senha precisa ter letras e números.';
  return null;
}

/** Hash fixo para comparar quando o e-mail não existe (tempo de resposta igual). */
export const HASH_FALSO = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
