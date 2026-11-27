import { z } from 'zod';
import { normalizarCep, normalizarDocumento, normalizarTelefone, UFS } from './validacao.js';

/** Texto opcional: "" e só espaços viram null (para limpar o campo). */
export const textoOpcional = (max: number) =>
  z.string().trim().max(max, `Máximo de ${max} caracteres`).nullish()
    .transform((v) => (v ? v : null));

export const telefoneObrigatorio = z.string().trim().min(1, 'Informe o telefone/WhatsApp')
  .transform((v, ctx) => {
    const n = normalizarTelefone(v);
    if (!n) { ctx.addIssue({ code: 'custom', message: 'Telefone inválido. Use DDD + número, ex.: (11) 98765-4321' }); return z.NEVER; }
    return n;
  });

export const telefoneOpcional = z.string().trim().nullish().transform((v, ctx) => {
  if (!v) return null;
  const n = normalizarTelefone(v);
  if (!n) { ctx.addIssue({ code: 'custom', message: 'Telefone inválido. Use DDD + número, ex.: (11) 98765-4321' }); return z.NEVER; }
  return n;
});

export const documentoOpcional = z.string().trim().nullish().transform((v, ctx) => {
  if (!v) return null;
  const d = normalizarDocumento(v);
  if (!d) { ctx.addIssue({ code: 'custom', message: 'CPF/CNPJ inválido (confira os dígitos)' }); return z.NEVER; }
  return d;
});

export const cepOpcional = z.string().trim().nullish().transform((v, ctx) => {
  if (!v) return null;
  const c = normalizarCep(v);
  if (!c) { ctx.addIssue({ code: 'custom', message: 'CEP deve ter 8 dígitos' }); return z.NEVER; }
  return c;
});

export const ufOpcional = z.string().trim().toUpperCase().nullish().transform((v, ctx) => {
  if (!v) return null;
  if (!(UFS as readonly string[]).includes(v)) { ctx.addIssue({ code: 'custom', message: 'UF inválida' }); return z.NEVER; }
  return v;
});

export const emailOpcional = z.string().trim().toLowerCase().nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    if (!z.email().safeParse(v).success || v.length > 150) { ctx.addIssue({ code: 'custom', message: 'E-mail inválido' }); return z.NEVER; }
    return v;
  });

/** Campos de endereço comuns a clientes e fornecedores. */
export const endereco = {
  cep: cepOpcional,
  logradouro: textoOpcional(160),
  numero: textoOpcional(20),
  complemento: textoOpcional(100),
  bairro: textoOpcional(100),
  cidade: textoOpcional(100),
  uf: ufOpcional,
};

/** Primeira mensagem de erro do zod, com o nome do campo quando ajuda. */
export function mensagemErro(e: z.ZodError): string {
  const i = e.issues[0];
  if (!i) return 'Dados inválidos.';
  return i.message;
}

/** Termo de busca: escapa curingas do LIKE (% e _ são texto, ex.: "Solar 3%"). */
export function termoLike(t: string): string {
  return `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
