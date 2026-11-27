import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Formato do orçamento que o app manda (online ou da fila offline).
 * O app manda só o que o vendedor escolheu: medidas, opções e ajustes. Preço, custo,
 * rateio e margem são sempre recalculados aqui (o cálculo do aparelho é provisório).
 */

const num = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const s = String(v).trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) { ctx.addIssue({ code: 'custom', message: `Número inválido: "${v}"` }); return z.NEVER; }
  return s;
});

/** Validação de sanidade da medida (12.5): evita erro de 100x (digitou cm achando que era m). */
const medidaM = (rotulo: string, max: number) => num.refine((s) => Number(s) > 0 && Number(s) <= max, {
  message: `${rotulo} fora do normal (máximo ${max} m). Confira se digitou em metros.`,
});
const largura = medidaM('Largura', 15);
const altura = medidaM('Altura', 10);
const medidaOuLista = (m: typeof largura) => z.union([m, z.array(m).min(1).max(3)]);
const sku = z.string().trim().toUpperCase().min(2).max(30);
const textoCurto = (max: number) => z.string().trim().max(max);

const camada = z.object({ sku, fator: num.optional(), margemBarra: num.optional() });

export const entradaCortina = z.object({
  larguraTrilho: largura,
  alturaPronta: altura,
  numFolhas: z.union([z.literal(1), z.literal(2)]),
  confeccao: z.enum(['WAVE', 'PREGA', 'FRANZIDO']),
  tecido: camada,
  forro: camada.extend({ desconto: num.optional() }).optional(),
  skus: z.record(z.string(), sku).optional(),
  folgaBainhaLateral: num.optional(),
  arredondamentoML: num.optional(),
  baseMaoObra: z.enum(['ML_TECIDO', 'ML_TRILHO']).optional(),
  exigirSimetriaTiras: z.boolean().optional(),
  profundidadeCortineiroM: num.optional(),
  limitePeDireitoAltoM: num.optional(),
});

const folga = z.object({ largura: num, altura: num });
export const entradaPersiana = z.object({
  sku,
  medida: z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('PRODUCAO'), largura, altura }),
    z.object({
      tipo: z.literal('VAO_BRUTO'),
      modo: z.enum(['DENTRO_VAO', 'FORA_VAO', 'TETO']),
      largura: medidaOuLista(largura),
      altura: medidaOuLista(altura),
      folgas: z.object({ dentroVao: folga, foraVao: folga, teto: folga }).partial().optional(),
    }),
  ]),
  acionamento: z.enum(['MANUAL', 'MOTORIZADO']),
  ladoComando: z.enum(['DIREITO', 'ESQUERDO']),
  sentidoEnrolamento: z.enum(['NORMAL', 'REVERSO']),
  fixacao: z.enum(['TETO', 'PAREDE']).optional(),
  possuiBando: z.boolean().optional(),
  folgaBandoM: num.optional(),
  possuiGuiaLateral: z.boolean().optional(),
  possuiCalhaInferior: z.boolean().optional(),
  incluirRedutorPeso: z.boolean().optional(),
  qtdControles: z.number().int().min(0).max(20).optional(),
  qtdHubs: z.number().int().min(0).max(5).optional(),
  numPecas: z.number().int().min(1).max(10).optional(),
  skus: z.record(z.string(), sku).optional(),
});

const motivo = textoCurto(200).optional();
export const ajuste = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('QUANTIDADE'), sku, quantidade: num, motivo }),
  z.object({ tipo: z.literal('REMOVER'), sku, motivo }),
  z.object({ tipo: z.literal('ADICIONAR'), sku, quantidade: num, motivo }),
  z.object({ tipo: z.literal('SUBSTITUIR'), sku, novoSku: sku, motivo }),
]);

const itemBase = {
  id: z.uuid(),
  ambiente: textoCurto(100).min(1, 'Informe o ambiente (ex.: Sala)'),
  descricaoComercial: textoCurto(300).optional(),
  ajustes: z.array(ajuste).max(60).default([]),
};
export const itemDocumento = z.discriminatedUnion('tipo', [
  z.object({ ...itemBase, tipo: z.literal('CORTINA'), entrada: entradaCortina }),
  z.object({ ...itemBase, tipo: z.literal('PERSIANA'), entrada: entradaPersiana }),
]);
export type ItemDocumento = z.infer<typeof itemDocumento>;

export const FORMAS_PAGAMENTO = ['PIX', 'CREDITO_AVISTA', 'CREDITO_PARCELADO', 'DEBITO', 'BOLETO', 'DINHEIRO', 'MISTO'] as const;

export const condicoes = z.object({
  descontoTipo: z.enum(['PERCENTUAL', 'VALOR']).default('PERCENTUAL'),
  descontoValor: num.default('0'),
  acrescimo: num.default('0'),
  formaPagamento: z.enum(FORMAS_PAGAMENTO).nullish(),
  parcelas: z.number().int().min(1).max(24).default(1),
  validadeAte: z.iso.date().nullish(),
  prazoEntregaDias: z.number().int().min(0).max(365).nullish(),
  garantiaTexto: textoCurto(300).nullish(),
  condicoesPagamentoTexto: textoCurto(300).nullish(),
  observacoesCliente: textoCurto(4000).nullish(),
  observacoesInternas: textoCurto(4000).nullish(),
  medidasConferidas: z.boolean().default(false),
});
export type Condicoes = z.infer<typeof condicoes>;

export const documentoEntrada = z.object({
  /** Gerado no aparelho a cada envio: reenviar o mesmo não aplica duas vezes. */
  idOperacao: z.uuid().optional(),
  /** `atualizadoEm` que o aparelho tinha. Diferente do servidor = conflito -> nova versão. */
  atualizadoEmBase: z.iso.datetime({ offset: true }).nullish(),
  clienteId: z.uuid(),
  titulo: textoCurto(120).nullish(),
  condicoes: condicoes.default(() => condicoes.parse({})),
  itens: z.array(itemDocumento).max(80),
  /** Recalcula também os itens que não mudaram (preço do catálogo de hoje). */
  atualizarPrecos: z.boolean().default(false),
  /** Gravado sem internet (vai para a auditoria). */
  offline: z.boolean().default(false),
  /** Total que o aparelho calculou, para avisar se o preço oficial ficou diferente. */
  vendaTotalLocal: num.nullish(),
});
export type DocumentoEntrada = z.infer<typeof documentoEntrada>;

/** JSON com chaves ordenadas: o mesmo item gera sempre o mesmo hash. */
export function jsonEstavel(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonEstavel).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${jsonEstavel((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function hashItem(i: Pick<ItemDocumento, 'tipo' | 'entrada' | 'ajustes'>): string {
  return createHash('sha256').update(jsonEstavel({ tipo: i.tipo, entrada: i.entrada, ajustes: i.ajustes })).digest('hex');
}
