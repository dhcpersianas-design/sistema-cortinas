/**
 * Normalização e validação dos campos de cadastro (clientes e fornecedores).
 * Regras da especificação v1.1, seção 10.
 */

export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

export const soDigitos = (v: string) => v.replace(/\D/g, '');

/**
 * Telefone brasileiro no padrão +55DDNNNNNNNNN (seção 10).
 * Aceita "(11) 98765-4321", "11987654321", "+55 11 98765-4321", "011 98765-4321".
 * Fixo (8 dígitos) também vale. Devolve null se não der para entender.
 */
export function normalizarTelefone(entrada: string): string | null {
  let n = soDigitos(entrada);
  if (n.startsWith('00')) n = n.slice(2);
  if ((n.length === 12 || n.length === 13) && n.startsWith('55')) n = n.slice(2);
  if (n.length === 11 && n.startsWith('0')) n = n.slice(1); // 0 + DDD + fixo
  if (n.length === 12 && n.startsWith('0')) n = n.slice(1); // 0 + DDD + celular
  if (n.length !== 10 && n.length !== 11) return null;
  const ddd = Number(n.slice(0, 2));
  if (ddd < 11 || ddd > 99 || n[0] === '0' || n[1] === '0') return null;
  if (n.length === 11 && n[2] !== '9') return null; // celular sempre começa com 9
  return `+55${n}`;
}

/** "+5511987654321" → "(11) 98765-4321". */
export function formatarTelefone(normalizado: string | null | undefined): string {
  if (!normalizado) return '';
  const n = normalizado.replace(/^\+55/, '');
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return normalizado;
}

/** Link wa.me (seção 12.5: sem custo de API). Mensagem opcional já codificada. */
export function linkWhatsapp(normalizado: string | null | undefined, mensagem?: string): string | null {
  if (!normalizado) return null;
  const base = `https://wa.me/${soDigitos(normalizado)}`;
  return mensagem ? `${base}?text=${encodeURIComponent(mensagem)}` : base;
}

function digitoVerificador(numeros: string, pesos: number[]): number {
  const soma = pesos.reduce((s, p, i) => s + Number(numeros[i]) * p, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function cpfValido(v: string): boolean {
  const n = soDigitos(v);
  if (n.length !== 11 || /^(\d)\1{10}$/.test(n)) return false;
  const d1 = digitoVerificador(n, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoVerificador(n, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(n[9]) && d2 === Number(n[10]);
}

export function cnpjValido(v: string): boolean {
  const n = soDigitos(v);
  if (n.length !== 14 || /^(\d)\1{13}$/.test(n)) return false;
  const d1 = digitoVerificador(n, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digitoVerificador(n, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(n[12]) && d2 === Number(n[13]);
}

/** CPF (11 dígitos) ou CNPJ (14). Devolve só os dígitos e o tipo, ou null se inválido. */
export function normalizarDocumento(v: string): { digitos: string; tipo: 'PF' | 'PJ' } | null {
  const n = soDigitos(v);
  if (n.length === 11 && cpfValido(n)) return { digitos: n, tipo: 'PF' };
  if (n.length === 14 && cnpjValido(n)) return { digitos: n, tipo: 'PJ' };
  return null;
}

export function formatarDocumento(d: string | null | undefined): string {
  if (!d) return '';
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return d;
}

/** CEP "01310-100" / "01310100" → "01310-100". */
export function normalizarCep(v: string): string | null {
  const n = soDigitos(v);
  return n.length === 8 ? `${n.slice(0, 5)}-${n.slice(5)}` : null;
}
