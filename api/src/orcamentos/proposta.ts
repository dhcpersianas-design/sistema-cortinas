import PDFDocument from 'pdfkit';
import { sql } from 'drizzle-orm';
import { d, garantiaDoItem, textoGarantia, type GarantiaItem } from '@sistema/motor-calculo';
import { carregarCatalogoDoBanco } from '../catalogo/catalogo-banco.js';
import type { Banco } from '../db/conexao.js';
import { formatarTelefone } from '../cadastros/validacao.js';
import { lerDocumento } from './servico.js';
import { repasseLigado, simularCartao } from '../financeiro/servico.js';

/**
 * Proposta comercial do cliente (especificação v1.1, seção 12.3 item 1).
 * Visual limpo, agrupado por ambiente: descrição comercial, medidas, valor do item,
 * total, condições, prazo, garantia e validade. NUNCA custo. Componentes só com
 * "Detalhar componentes" (e mesmo assim só nome e quantidade, sem preço unitário).
 */

export const dinheiroBR = (v: string) => {
  const [int, dec] = d(v).toFixed(2).split('.');
  return `R$ ${int!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
};
const metros = (v: string) => `${d(v).toFixed(2).replace('.', ',')} m`;
const dataBR = (v: string | Date | null) => {
  if (!v) return '';
  const s = typeof v === 'string' ? v : v.toISOString();
  const [a, m, dd] = s.slice(0, 10).split('-');
  return `${dd}/${m}/${a}`;
};
const qtd = (v: string, un: string) => (un === 'UN' || un === 'PC' ? d(v).toFixed(0) : d(v).toFixed(2).replace('.', ','));

const FORMAS: Record<string, string> = {
  PIX: 'PIX', CREDITO_AVISTA: 'Cartão de crédito à vista', CREDITO_PARCELADO: 'Cartão de crédito parcelado',
  DEBITO: 'Cartão de débito', BOLETO: 'Boleto', DINHEIRO: 'Dinheiro', MISTO: 'Pagamento combinado',
};

export type DadosProposta = {
  loja: { nome: string; cnpj: string | null };
  codigo: string; versao: number; data: string; validadeAte: string; titulo: string | null; rascunho: boolean;
  cliente: { nome: string; telefone: string; endereco: string };
  vendedor: string;
  ambientes: { nome: string; itens: { descricao: string; medidas: string; valor: string; garantia: string; componentes?: { descricao: string; quantidade: string }[] }[]; subtotal: string }[];
  subtotal: string; desconto: string | null; acrescimo: string | null; total: string;
  condicoesPagamento: string; prazoEntrega: string | null; garantia: string; observacoes: string | null;
  avisoConferencia: boolean;
};

export async function montarProposta(db: Banco, id: string, detalhar: boolean): Promise<DadosProposta | null> {
  const doc = await lerDocumento(db, id);
  if (!doc) return null;
  const { c, itens } = doc;
  const [loja] = (await db.execute(sql`SELECT nome, cnpj FROM lojas WHERE id = ${c.lojaId}`)).rows as { nome: string; cnpj: string | null }[];
  const [cli] = (await db.execute(sql`SELECT CONCAT_WS(', ', NULLIF(CONCAT_WS(' ', logradouro, numero), ''), complemento, bairro,
      NULLIF(CONCAT_WS(' - ', cidade, uf), '')) AS endereco FROM clientes WHERE id = ${c.clienteId}`)).rows as { endereco: string | null }[];
  // Garantia por item: a gravada no item (snapshot); orçamento antigo sem ela usa o catálogo de hoje.
  let catalogo: Awaited<ReturnType<typeof carregarCatalogoDoBanco>>['catalogo'] | null = null;
  const garantia = async (i: (typeof itens)[number]) => {
    const g = (i.especificacaoTecnica as { garantia?: GarantiaItem }).garantia;
    if (g) return textoGarantia(g);
    catalogo ??= (await carregarCatalogoDoBanco(db)).catalogo;
    return textoGarantia(garantiaDoItem(i.componentes.map((x) => x.sku), catalogo));
  };

  const grupos = new Map<string, DadosProposta['ambientes'][number]>();
  for (const i of itens) {
    const g = grupos.get(i.ambiente) ?? { nome: i.ambiente, itens: [], subtotal: '0' };
    g.itens.push({
      descricao: i.descricaoComercial,
      medidas: `${metros(i.larguraProducao)} x ${metros(i.alturaProducao)}`,
      valor: dinheiroBR(i.vendaTotal),
      garantia: await garantia(i),
      ...(detalhar ? { componentes: i.componentes.map((x) => ({ descricao: x.descricao, quantidade: `${qtd(x.quantidade, x.unidade)} ${x.unidade}` })) } : {}),
    });
    g.subtotal = d(g.subtotal).plus(d(i.vendaTotal)).toFixed(2);
    grupos.set(i.ambiente, g);
  }
  const forma = c.formaPagamento ? FORMAS[c.formaPagamento] ?? c.formaPagamento : null;
  // Cartão com a taxa repassada (Gabriel, 27/11/2026): o valor no cartão já vem com a taxa embutida e
  // a proposta mostra só o valor final das parcelas, sem falar em taxa. [suposição] usa a tabela
  // Visa/Mastercard; na hora de receber o sistema calcula pela bandeira escolhida.
  const repasse = await repasseLigado(db, c.lojaId);
  const cartao = c.formaPagamento != null && ['DEBITO', 'CREDITO_AVISTA', 'CREDITO_PARCELADO'].includes(c.formaPagamento);
  let textoForma: string | null = null;
  if (forma && cartao && repasse && d(c.total).gt(0)) {
    const s = await simularCartao(db, c.lojaId, d(c.total), c.formaPagamento!, c.parcelas ?? 1, 'VISA_MASTER');
    textoForma = s.parcelas > 1 ? `${forma} em ${s.parcelas}x de ${dinheiroBR(s.valorParcela)}` : `${forma}: ${dinheiroBR(s.cobrado)}`;
  } else if (forma) {
    textoForma = `${forma}${(c.parcelas ?? 1) > 1 ? ` em ${c.parcelas}x de ${dinheiroBR(d(c.total).div(c.parcelas!).toFixed(2))}` : ''}`;
  }
  let opcaoCartao: string | null = null;
  if (repasse && !cartao && d(c.total).gt(0)) {
    const s = await simularCartao(db, c.lojaId, d(c.total), 'CREDITO_PARCELADO', 12, 'VISA_MASTER');
    opcaoCartao = `${forma ? 'Ou no' : 'No'} cartão de crédito em até 12x de ${dinheiroBR(s.valorParcela)}`;
  }
  const condicoes = [textoForma, opcaoCartao, c.condicoesPagamentoTexto].filter(Boolean).join('. ') || 'A combinar.';
  return {
    loja: { nome: loja?.nome ?? 'Loja', cnpj: loja?.cnpj ?? null },
    codigo: c.codigo, versao: c.versao, data: dataBR(c.enviadoEm ?? c.atualizadoEm), validadeAte: dataBR(c.validadeAte),
    titulo: c.titulo, rascunho: c.status === 'RASCUNHO',
    cliente: { nome: c.clienteNome, telefone: formatarTelefone(c.clienteTelefone), endereco: cli?.endereco ?? '' },
    vendedor: c.vendedorNome,
    ambientes: [...grupos.values()].map((g) => ({ ...g, subtotal: dinheiroBR(g.subtotal) })),
    subtotal: dinheiroBR(c.subtotal),
    desconto: d(c.descontoValor).gt(0) ? `- ${dinheiroBR(c.descontoValor)}` : null,
    acrescimo: d(c.acrescimo).gt(0) ? dinheiroBR(c.acrescimo) : null,
    total: dinheiroBR(c.total),
    condicoesPagamento: condicoes,
    prazoEntrega: c.prazoEntregaDias != null
      ? `${c.prazoEntregaDias} dias úteis (sem contar sábado e domingo) após a confirmação do pedido e da medição.` : null,
    garantia: c.garantiaTexto || 'Contra defeitos de fabricação e instalação, no prazo indicado em cada item.',
    observacoes: c.observacoesCliente,
    avisoConferencia: !c.medidasConferidas,
  };
}

/** Gera o PDF (A4) com as fontes padrão do PDF (acentos do português funcionam). */
export function gerarPdf(p: DadosProposta, opcoes: { comprimir?: boolean } = {}): Promise<Buffer> {
  return new Promise((ok, falha) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, compress: opcoes.comprimir ?? true, info: { Title: `Proposta ${p.codigo} v${p.versao}`, Author: p.loja.nome } });
    const partes: Buffer[] = [];
    doc.on('data', (b: Buffer) => partes.push(b));
    doc.on('end', () => ok(Buffer.concat(partes)));
    doc.on('error', falha);

    const cor = '#1f4d3f';
    const cinza = '#666666';
    const largura = doc.page.width - 96;
    const x0 = 48;

    // Cabeçalho
    doc.font('Helvetica-Bold').fontSize(18).fillColor(cor).text(p.loja.nome, x0, 48);
    if (p.loja.cnpj) doc.font('Helvetica').fontSize(9).fillColor(cinza).text(`CNPJ ${p.loja.cnpj}`);
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text(`Proposta comercial ${p.codigo}${p.versao > 1 ? ` (versão ${p.versao})` : ''}`);
    if (p.rascunho) doc.font('Helvetica-Bold').fontSize(10).fillColor('#b45309').text('RASCUNHO: ainda não enviada ao cliente');
    doc.font('Helvetica').fontSize(10).fillColor(cinza).text(`Data: ${p.data}    Validade: ${p.validadeAte}    Vendedor: ${p.vendedor}`);
    doc.moveDown(0.8);

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('Cliente');
    doc.font('Helvetica').fontSize(10).text(p.cliente.nome);
    if (p.cliente.telefone) doc.text(p.cliente.telefone);
    if (p.cliente.endereco) doc.text(p.cliente.endereco);
    if (p.titulo) doc.text(`Projeto: ${p.titulo}`);
    doc.moveDown(0.8);

    const linha = () => { doc.moveTo(x0, doc.y).lineTo(x0 + largura, doc.y).strokeColor('#dddddd').lineWidth(0.5).stroke(); doc.moveDown(0.3); };
    const colValor = 110;
    const quebra = (altura: number) => { if (doc.y + altura > doc.page.height - 60) doc.addPage(); };

    for (const a of p.ambientes) {
      quebra(60);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(cor).text(a.nome, x0, doc.y);
      doc.moveDown(0.2);
      linha();
      for (const [n, i] of a.itens.entries()) {
        quebra(40);
        const y = doc.y;
        doc.font('Helvetica').fontSize(10).fillColor('#000')
          .text(`${String(n + 1).padStart(2, '0')}  ${i.descricao}`, x0, y, { width: largura - colValor - 10 });
        const yFim = doc.y;
        doc.font('Helvetica-Bold').text(i.valor, x0 + largura - colValor, y, { width: colValor, align: 'right' });
        doc.y = Math.max(yFim, doc.y);
        doc.font('Helvetica').fontSize(9).fillColor(cinza).text(`Medidas: ${i.medidas}    Garantia: ${i.garantia}`, x0 + 18);
        if (i.componentes?.length) {
          for (const c of i.componentes) { quebra(14); doc.text(`• ${c.descricao}: ${c.quantidade}`, x0 + 28); }
        }
        doc.moveDown(0.5);
      }
      doc.font('Helvetica').fontSize(9).fillColor(cinza).text(`Subtotal ${a.nome}: ${a.subtotal}`, x0, doc.y, { width: largura, align: 'right' });
      doc.moveDown(0.8);
    }

    quebra(90);
    linha();
    const total = (rotulo: string, valor: string, forte = false) => {
      const y = doc.y;
      doc.font(forte ? 'Helvetica-Bold' : 'Helvetica').fontSize(forte ? 13 : 10).fillColor('#000')
        .text(rotulo, x0 + largura - 300, y, { width: 180, align: 'right' });
      doc.text(valor, x0 + largura - colValor, y, { width: colValor, align: 'right' });
      doc.moveDown(0.3);
    };
    if (p.desconto || p.acrescimo) total('Subtotal', p.subtotal);
    if (p.desconto) total('Desconto', p.desconto);
    if (p.acrescimo) total('Acréscimo', p.acrescimo);
    total('Total', p.total, true);
    doc.moveDown(0.8);

    const bloco = (titulo: string, texto: string) => {
      quebra(40);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(titulo, x0, doc.y, { width: largura });
      doc.font('Helvetica').fontSize(10).fillColor('#000').text(texto, { width: largura });
      doc.moveDown(0.5);
    };
    bloco('Condições de pagamento', p.condicoesPagamento);
    if (p.prazoEntrega) bloco('Prazo de entrega e instalação', p.prazoEntrega);
    bloco('Garantia', p.garantia);
    bloco('Validade da proposta', `Até ${p.validadeAte}.`);
    if (p.observacoes) bloco('Observações', p.observacoes);
    if (p.avisoConferencia) {
      quebra(30);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#b45309').text('Valores sujeitos a conferência técnica no local.', x0, doc.y, { width: largura });
    }
    doc.end();
  });
}
