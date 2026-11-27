import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { sql } from 'drizzle-orm';
import { d, garantiaDoItem, textoGarantia, SKUS_CORTINA_PADRAO, type GarantiaItem } from '@sistema/motor-calculo';
import { carregarCatalogoDoBanco } from '../catalogo/catalogo-banco.js';
import type { Banco } from '../db/conexao.js';
import { formatarTelefone } from '../cadastros/validacao.js';
import { lerDocumento, type ItemCompleto } from './servico.js';
import { regraCartao, simularCartao } from '../financeiro/servico.js';

/**
 * Proposta comercial do cliente (especificação v1.1, seção 12.3 item 1), com a identidade
 * da DHC Persianas & Cortinas: logo, fundo bege da faixa da logo, fonte Montserrat embutida.
 * Agrupada por ambiente: nome do produto, medidas, detalhes, quantidade de peças e valor.
 * Garantia e avisos ficam numa seção no final. NUNCA custo nem teto de desconto.
 * Componentes só com "Detalhar componentes" (e mesmo assim só nome e quantidade).
 */

export const dinheiroBR = (v: string) => {
  const [int, dec] = d(v).toFixed(2).split('.');
  return `R$ ${int!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
};
const num2 = (v: string) => d(v).toFixed(2).replace('.', ',');
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

/** Desenho pequeno ao lado do item. */
export type IconeItem = 'CORTINA' | 'ROLO' | 'HORIZONTAL' | 'VERTICAL' | 'SERVICO';

export type ItemProposta = {
  titulo: string;
  medidas: string;
  detalhes: { rotulo: string; valor: string }[];
  pecas: number;
  icone: IconeItem;
  valor: string;
  garantia: string;
  componentes?: { descricao: string; quantidade: string }[];
};

export type DadosProposta = {
  loja: { nome: string; cnpj: string | null; telefone: string | null; email: string | null; instagram: string | null };
  codigo: string; versao: number; data: string; validadeAte: string; titulo: string | null; rascunho: boolean;
  cliente: { nome: string; telefone: string; endereco: string };
  vendedor: string;
  ambientes: { nome: string; itens: ItemProposta[]; subtotal: string }[];
  subtotal: string; desconto: string | null; acrescimo: string | null; total: string;
  condicoesPagamento: string; prazoEntrega: string | null; garantia: string; observacoes: string | null;
  avisoConferencia: boolean;
};

// ------------------------------------------------------------------ item: título, medidas e detalhes

/** Descrição gerada pelo sistema termina com "(L m x A m)"; a digitada pelo vendedor fica como está. */
const MEDIDAS_NO_FIM = /\s*\(\s*[\d.,]+\s*m\s*x\s*[\d.,]+\s*m\s*\)\s*$/i;

type EntradaSalva = Record<string, unknown> & {
  sku?: string; acionamento?: string; ladoComando?: string; fixacao?: string; numPecas?: number;
  possuiBando?: boolean; possuiGuiaLateral?: boolean; possuiCalhaInferior?: boolean;
  confeccao?: string; numFolhas?: number; trilhoMotorizado?: string; tecido?: { sku?: string }; forro?: { sku?: string } | null; skus?: { trilho?: string };
  servicos?: { sku: string; quantidade: string | number }[];
};

export function descreverItem(i: Pick<ItemCompleto, 'tipo' | 'descricaoComercial' | 'larguraProducao' | 'alturaProducao' | 'entrada' | 'componentes'>) {
  const e = (i.entrada ?? {}) as EntradaSalva;
  const nomeSku = (sku?: string) => (sku ? i.componentes.find((c) => c.sku === sku)?.descricao : undefined);
  const automatica = MEDIDAS_NO_FIM.test(i.descricaoComercial);
  const instalacao = i.componentes.some((c) => /instala/i.test(c.descricao));
  const detalhes: { rotulo: string; valor: string }[] = [];
  const add = (rotulo: string, valor: string | null | undefined) => { if (valor) detalhes.push({ rotulo, valor }); };
  let titulo = i.descricaoComercial.replace(MEDIDAS_NO_FIM, '').trim() || i.descricaoComercial;
  let icone: IconeItem;
  let pecas = 1;

  if (i.tipo === 'SERVICO') {
    // Só serviço (sem produto): sem medidas e sem contagem de peças.
    for (const sv of e.servicos ?? []) {
      const q = Number(sv.quantidade);
      add(nomeSku(sv.sku) ?? sv.sku, Number.isFinite(q) && q !== 1 ? `${String(sv.quantidade).replace('.', ',')}x` : 'Incluso');
    }
    // Título automático já lista os serviços; com texto do vendedor, os serviços aparecem como detalhes.
    return { titulo, medidas: '', detalhes: detalhes.filter((x) => !titulo.includes(x.rotulo)), pecas: 0, icone: 'SERVICO' as IconeItem };
  }
  if (i.tipo === 'CORTINA') {
    icone = 'CORTINA';
    const conf = ({ WAVE: 'Wave', PREGA: 'Prega macho', FRANZIDO: 'Franzida' } as Record<string, string>)[e.confeccao ?? ''] ?? '';
    if (automatica) titulo = `Cortina ${conf}`.trim();
    add('Tecido', nomeSku(e.tecido?.sku));
    add('Forro', nomeSku(e.forro?.sku ?? undefined));
    add('Abertura', e.numFolhas === 2 ? 'Central (2 folhas)' : e.numFolhas === 1 ? 'Lateral (1 folha)' : null);
    if (e.trilhoMotorizado) {
      add('Trilho', nomeSku(e.trilhoMotorizado));
      add('Acionamento', 'Motorizado');
    } else add('Trilho / varão', nomeSku(e.skus?.trilho ?? SKUS_CORTINA_PADRAO.trilho));
  } else {
    const produto = nomeSku(e.sku) ?? titulo;
    icone = /horizonta|venezian|alum[ií]nio|madeira/i.test(produto) ? 'HORIZONTAL' : /vertica/i.test(produto) ? 'VERTICAL' : 'ROLO';
    if (automatica) titulo = produto;
    pecas = Math.max(1, Number(e.numPecas ?? 1) || 1);
    const lado = e.ladoComando === 'ESQUERDO' ? 'comando à esquerda' : e.ladoComando === 'DIREITO' ? 'comando à direita' : null;
    add('Acionamento', e.acionamento === 'MOTORIZADO' ? 'Motorizado' : ['Manual', lado].filter(Boolean).join(' · '));
    add('Fixação', e.fixacao === 'TETO' ? 'No teto' : e.fixacao === 'PAREDE' ? 'Na parede' : null);
    const acab = [e.possuiBando ? 'bandô' : null, e.possuiGuiaLateral ? 'guia lateral' : null, e.possuiCalhaInferior ? 'calha inferior' : null].filter(Boolean).join(', ');
    add('Acabamento', acab ? acab.charAt(0).toUpperCase() + acab.slice(1) : null);
  }
  add('Instalação', instalacao ? 'Inclusa' : null);
  return { titulo, medidas: `${num2(i.larguraProducao)} × ${num2(i.alturaProducao)} m (L × A)`, detalhes, pecas, icone };
}

export async function montarProposta(db: Banco, id: string, detalhar: boolean): Promise<DadosProposta | null> {
  const doc = await lerDocumento(db, id);
  if (!doc) return null;
  const { c, itens } = doc;
  const [loja] = (await db.execute(sql`SELECT nome, cnpj, telefone, email, instagram FROM lojas WHERE id = ${c.lojaId}`)).rows as
    { nome: string; cnpj: string | null; telefone: string | null; email: string | null; instagram: string | null }[];
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
      ...descreverItem(i),
      valor: dinheiroBR(i.vendaTotal),
      garantia: await garantia(i),
      ...(detalhar ? { componentes: i.componentes.map((x) => ({ descricao: x.descricao, quantidade: `${qtd(x.quantidade, x.unidade)} ${x.unidade}` })) } : {}),
    });
    g.subtotal = d(g.subtotal).plus(d(i.vendaTotal)).toFixed(2);
    grupos.set(i.ambiente, g);
  }
  const forma = c.formaPagamento ? FORMAS[c.formaPagamento] ?? c.formaPagamento : null;
  // Formas de pagamento (Gabriel, 27/11/2026): desconto só no PIX à vista; débito (à vista) e crédito até 3x sem
  // juros pelo valor cheio; de 4x a 12x a taxa (tabela Visa/Mastercard) vai embutida no valor cheio.
  // A proposta mostra só o valor final das parcelas, sem falar em taxa.
  const regra = await regraCartao(db, c.lojaId);
  const cheio = d(c.subtotal).plus(d(c.acrescimo));
  const descontoPix = c.descontoTipo === 'PERCENTUAL' ? d(c.subtotal).mul(d(c.descontoInformado)).div(100).toDecimalPlaces(2) : d(c.descontoInformado);
  const pix = cheio.minus(descontoPix);
  const parcelaTxt = async (n: number) => {
    const sim = await simularCartao(db, c.lojaId, cheio, n > 1 ? 'CREDITO_PARCELADO' : 'CREDITO_AVISTA', n, 'VISA_MASTER');
    return `${n}x de ${dinheiroBR(sim.valorParcela)}`;
  };
  const linhasPg: string[] = [];
  if (cheio.gt(0)) {
    const fp = c.formaPagamento;
    if (fp && fp !== 'PIX') {
      if (fp === 'CREDITO_PARCELADO' && (c.parcelas ?? 1) > 1) {
        const n = c.parcelas!;
        linhasPg.push(`${forma} em ${await parcelaTxt(n)}${n <= regra.semJuros ? ' sem juros' : ''}`);
      } else {
        linhasPg.push(`${forma}: ${dinheiroBR(cheio.toFixed(2))}`);
      }
      if (pix.lt(cheio)) linhasPg.push(`Ou à vista no PIX: ${dinheiroBR(pix.toFixed(2))}`);
    } else {
      linhasPg.push(`À vista no PIX: ${dinheiroBR(pix.toFixed(2))}`);
      const sj = regra.semJuros;
      // Débito não parcela: linha própria, à vista. As parcelas valem só para o crédito.
      linhasPg.push(`Cartão de débito à vista: ${dinheiroBR(cheio.toFixed(2))}`);
      linhasPg.push(sj >= 2
        ? `Cartão de crédito em até ${sj}x sem juros: ${dinheiroBR(cheio.toFixed(2))} (${sj}x de ${dinheiroBR(cheio.div(sj).toDecimalPlaces(2, 0).toFixed(2))})`
        : `Cartão de crédito à vista: ${dinheiroBR(cheio.toFixed(2))}`);
      linhasPg.push(`Ou no cartão de crédito em até ${await parcelaTxt(12)}`);
    }
  }
  const condicoes = [...linhasPg, c.condicoesPagamentoTexto].filter(Boolean).join('. ') || 'A combinar.';
  return {
    loja: {
      nome: loja?.nome ?? 'Loja', cnpj: loja?.cnpj || null, telefone: loja?.telefone || null,
      email: loja?.email || null, instagram: loja?.instagram || null,
    },
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
    garantia: c.garantiaTexto || 'Contra defeitos de fabricação e instalação, no prazo indicado para cada item abaixo.',
    observacoes: c.observacoesCliente,
    avisoConferencia: !c.medidasConferidas,
  };
}

// ------------------------------------------------------------------ PDF

/** Logo e fontes ficam em api/assets (mesmo caminho a partir de src/ e de dist/). */
const ASSETS = fileURLToPath(new URL('../../assets/', import.meta.url));
const LOGO = `${ASSETS}logo-dhc.png`;
const FONTES = {
  normal: `${ASSETS}fontes/Montserrat-Regular.ttf`,
  medio: `${ASSETS}fontes/Montserrat-Medium.ttf`,
  semi: `${ASSETS}fontes/Montserrat-SemiBold.ttf`,
  negrito: `${ASSETS}fontes/Montserrat-Bold.ttf`,
} as const;

/**
 * Cores da marca. Fundo = faixa bege atrás de "PERSIANAS & CORTINAS" na logo (#FAF8F5).
 * Contraste sobre o fundo: texto 14,7:1, texto secundário 6,8:1, destaque 5,8:1 (mínimo AA: 4,5:1).
 * O coral da logo (#EC5242) só aparece em linhas e desenhos, nunca em texto pequeno.
 */
export const CORES = {
  fundo: '#FAF8F5',
  texto: '#262322',
  secundario: '#5C5651',
  destaque: '#A8402C',
  coral: '#EC5242',
  linha: '#E2DBD3',
  painel: '#F2EDE7',
  icone: '#7A6F66',
} as const;

type Doc = InstanceType<typeof PDFDocument>;

function desenharIcone(doc: Doc, tipo: IconeItem, x: number, y: number, t = 34) {
  doc.save();
  doc.roundedRect(x, y, t, t, 5).fill(CORES.painel);
  doc.lineWidth(1).strokeColor(CORES.icone).fillColor(CORES.icone);
  const l = x + 8, r = x + t - 8, top = y + 7, bot = y + t - 7;
  if (tipo === 'CORTINA') {
    doc.moveTo(l - 2, top).lineTo(r + 2, top).lineWidth(1.6).stroke();
    doc.lineWidth(0.9);
    const meio = (l + r) / 2;
    for (const [a, b] of [[l, meio - 1.5], [meio + 1.5, r]] as const) {
      const passo = (b - a) / 3;
      for (let k = 0; k <= 3; k++) {
        const px = a + k * passo;
        doc.moveTo(px, top + 1.5).bezierCurveTo(px - 1.5, top + 8, px + 1.5, bot - 8, px, bot).stroke();
      }
    }
  } else if (tipo === 'HORIZONTAL') {
    doc.rect(l - 1, top, r - l + 2, 2.5).fill();
    doc.lineWidth(1.1);
    for (let k = 0; k < 6; k++) { const py = top + 6 + k * 3.2; doc.moveTo(l, py).lineTo(r, py).stroke(); }
    doc.lineWidth(0.5);
    doc.moveTo(l + 4, top + 2).lineTo(l + 4, bot).stroke();
    doc.moveTo(r - 4, top + 2).lineTo(r - 4, bot).stroke();
  } else if (tipo === 'SERVICO') {
    // chave de boca simples
    doc.lineWidth(2.2).moveTo(l + 2, bot - 2).lineTo(r - 6, top + 6).stroke();
    doc.lineWidth(1.4).circle(r - 4.5, top + 4.5, 4).stroke();
  } else if (tipo === 'VERTICAL') {
    doc.rect(l - 1, top, r - l + 2, 2.5).fill();
    doc.lineWidth(1.6);
    for (let k = 0; k < 5; k++) { const px = l + 1 + k * ((r - l - 2) / 4); doc.moveTo(px, top + 4).lineTo(px, bot).stroke(); }
  } else {
    doc.roundedRect(l - 2, top, r - l + 4, 4, 2).fill();
    doc.rect(l, top + 4, r - l - 3, bot - top - 7).lineWidth(0.9).stroke();
    doc.rect(l, bot - 3, r - l - 3, 2).fill();
    doc.lineWidth(0.6).moveTo(r + 0.5, top + 4).lineTo(r + 0.5, bot - 2).stroke();
  }
  doc.restore();
}

/** Gera o PDF (A4) com a identidade da loja e a fonte Montserrat embutida. */
export function gerarPdf(p: DadosProposta, opcoes: { comprimir?: boolean } = {}): Promise<Buffer> {
  return new Promise((ok, falha) => {
    const M = 42;
    const doc = new PDFDocument({
      size: 'A4', margins: { top: M, bottom: M, left: M, right: M }, bufferPages: true, compress: opcoes.comprimir ?? true,
      info: { Title: `Proposta ${p.codigo}${p.versao > 1 ? ` v${p.versao}` : ''}`, Author: p.loja.nome },
    });
    const partes: Buffer[] = [];
    doc.on('data', (b: Buffer) => partes.push(b));
    doc.on('end', () => ok(Buffer.concat(partes)));
    doc.on('error', falha);

    doc.registerFont('N', FONTES.normal);
    doc.registerFont('M', FONTES.medio);
    doc.registerFont('S', FONTES.semi);
    doc.registerFont('B', FONTES.negrito);

    const W = doc.page.width;
    const H = doc.page.height;
    const largura = W - 2 * M;
    const x0 = M;
    const limite = H - 64; // espaço do rodapé
    const fundo = () => { doc.save().rect(0, 0, W, H).fill(CORES.fundo).restore(); };
    fundo();
    doc.on('pageAdded', () => { fundo(); doc.y = M; });
    const quebra = (altura: number) => { if (doc.y + altura > limite) doc.addPage(); };
    const fonte = (f: 'N' | 'M' | 'S' | 'B', tam: number, cor: string = CORES.texto) => doc.font(f).fontSize(tam).fillColor(cor);
    const regua = (y: number, cor: string = CORES.linha, esp = 0.6, xi = x0, xf = x0 + largura) => {
      doc.save().moveTo(xi, y).lineTo(xf, y).lineWidth(esp).strokeColor(cor).stroke().restore();
    };
    const tituloSecao = (t: string) => {
      quebra(48);
      fonte('B', 10.5, CORES.destaque).text(t.toUpperCase(), x0, doc.y, { width: largura, characterSpacing: 0.8 });
      doc.y += 3;
      regua(doc.y, CORES.coral, 0.9);
      doc.y += 10;
    };

    // ---------------- cabeçalho
    const larguraDir = 210;
    const xDir = x0 + largura - larguraDir;
    if (existsSync(LOGO)) doc.image(LOGO, x0 - 6, M - 8, { width: 168 });
    let yEsq = M - 8 + 168 * (120 / 400) + 6;
    fonte('B', 13).text(p.loja.nome, x0, yEsq, { width: largura - larguraDir - 10 });
    const contato = [p.loja.cnpj ? `CNPJ ${p.loja.cnpj}` : null, p.loja.telefone, p.loja.email].filter(Boolean).join('  ·  ');
    if (contato) fonte('N', 8.5, CORES.secundario).text(contato, { width: largura - larguraDir + 30 });
    if (p.loja.instagram) fonte('N', 8.5, CORES.secundario).text(p.loja.instagram);
    yEsq = doc.y;

    fonte('B', 15).text('PROPOSTA COMERCIAL', xDir, M, { width: larguraDir, align: 'right', characterSpacing: 0.5 });
    doc.y += 2;
    /** Rótulo + valor alinhados à direita (o `continued` do pdfkit não alinha à direita direito). */
    const direita = (rotulo: string, valor: string, xFim: number, y: number, tam: number, fr: 'N' | 'S' = 'N', fv: 'S' | 'M' | 'B' = 'S') => {
      fonte(fv, tam);
      const wv = doc.widthOfString(valor);
      doc.text(valor, xFim - wv, y, { lineBreak: false });
      fonte(fr, tam, CORES.secundario);
      const wr = doc.widthOfString(rotulo);
      doc.text(rotulo, xFim - wv - wr, y, { lineBreak: false });
      doc.y = y + doc.currentLineHeight(true);
    };
    const linhaDir = (rotulo: string, valor: string) => direita(`${rotulo} `, valor, xDir + larguraDir, doc.y + 1, 9.5);
    linhaDir('Nº', `${p.codigo}${p.versao > 1 ? ` · versão ${p.versao}` : ''}`);
    linhaDir('Data:', p.data);
    linhaDir('Válida até:', p.validadeAte);
    linhaDir('Vendedor:', p.vendedor);
    if (p.rascunho) {
      doc.y += 4;
      fonte('B', 8.5, CORES.destaque).text('RASCUNHO · AINDA NÃO ENVIADA', xDir, doc.y, { width: larguraDir, align: 'right' });
    }
    doc.y = Math.max(yEsq, doc.y) + 12;
    regua(doc.y, CORES.texto, 1.4);
    doc.y += 16;

    // ---------------- cliente
    fonte('B', 8.5, CORES.destaque).text('CLIENTE', x0, doc.y, { characterSpacing: 1 });
    doc.y += 2;
    fonte('B', 12).text(p.cliente.nome, x0, doc.y, { width: largura });
    const infoCli = [p.cliente.telefone, p.cliente.endereco].filter(Boolean);
    for (const t of infoCli) fonte('N', 10).text(t, { width: largura });
    if (p.titulo) { fonte('N', 10, CORES.secundario).text('Projeto: ', { continued: true }); fonte('M', 10).text(p.titulo); }
    doc.y += 18;

    // ---------------- ambientes e itens
    const colValor = 110;
    const xIcone = x0;
    const xTexto = x0 + 46;
    const larguraTexto = largura - 46 - colValor - 8;
    const xValor = x0 + largura - colValor;

    /** Detalhes "Rótulo: valor" lado a lado, quebrando a linha sem separar rótulo e valor. Devolve o y final. */
    const escreverDetalhes = (i: ItemProposta, desenhar: boolean, y: number): number => {
      if (i.detalhes.length === 0) return y;
      const tam = 9;
      const alt = 13;
      const gap = 14;
      const xMax = xTexto + larguraTexto;
      let x = xTexto;
      let yl = y;
      for (const dd of i.detalhes) {
        const rot = `${dd.rotulo}: `;
        fonte('N', tam); const wr = doc.widthOfString(rot);
        fonte('M', tam); const wv = doc.widthOfString(dd.valor);
        if (x > xTexto && x + wr + wv > xMax) { x = xTexto; yl += alt; }
        if (desenhar) {
          fonte('N', tam, CORES.secundario).text(rot, x, yl, { lineBreak: false });
          const larguraValor = xMax - x - wr;
          if (wv <= larguraValor) fonte('M', tam).text(dd.valor, x + wr, yl, { lineBreak: false });
          else { fonte('M', tam).text(dd.valor, x + wr, yl, { width: larguraValor }); yl = doc.y - alt; x = xMax; }
        } else if (wv > xMax - x - wr) { fonte('M', tam); yl += doc.heightOfString(dd.valor, { width: xMax - x - wr }) - alt; x = xMax; }
        x += wr + wv + gap;
      }
      return yl + alt;
    };

    for (const a of p.ambientes) {
      tituloSecao(a.nome);
      a.itens.forEach((i, n) => {
        // altura estimada para não partir o item entre páginas
        fonte('B', 11);
        const hTitulo = doc.heightOfString(`${i.titulo}  ${i.medidas}`, { width: larguraTexto });
        const hDet = escreverDetalhes(i, false, 0);
        const hComp = (i.componentes?.length ?? 0) * 12;
        quebra(Math.max(hTitulo + hDet + hComp + 8, 38) + 12);

        const y = doc.y;
        desenharIcone(doc, i.icone, xIcone, y);
        fonte('B', 11).text(i.titulo, xTexto, y, { width: larguraTexto, continued: true });
        fonte('N', 10, CORES.secundario).text(`   ${i.medidas}`);
        doc.y += 3;
        let yFim = escreverDetalhes(i, true, doc.y);
        if (i.componentes?.length) {
          doc.y = yFim + 3;
          for (const c of i.componentes) fonte('N', 8.5, CORES.secundario).text(`•  ${c.descricao}: ${c.quantidade}`, xTexto + 4, doc.y, { width: larguraTexto - 4 });
          yFim = doc.y;
        }
        if (i.pecas > 0) fonte('N', 8.5, CORES.secundario).text(`${i.pecas} ${i.pecas === 1 ? 'peça' : 'peças'}`, xValor, y + 1, { width: colValor, align: 'right' });
        fonte('B', 11.5).text(i.valor, xValor, doc.y + 1, { width: colValor, align: 'right' });
        doc.y = Math.max(yFim, doc.y, y + 34) + 10;
        if (n < a.itens.length - 1) { regua(doc.y, CORES.linha, 0.6, xTexto); doc.y += 10; }
      });
      direita(`Subtotal ${a.nome}   `, a.subtotal, x0 + largura, doc.y, 9.5);
      doc.y += 16;
    }

    // ---------------- totais
    const linhasTot: [string, string][] = [];
    if (p.desconto || p.acrescimo) linhasTot.push(['Subtotal', p.subtotal]);
    if (p.desconto) linhasTot.push(['Desconto', p.desconto]);
    if (p.acrescimo) linhasTot.push(['Acréscimo', p.acrescimo]);
    const lTot = 250;
    const hTot = 20 + linhasTot.length * 16 + 26;
    quebra(hTot + 10);
    const yTot = doc.y;
    const xTot = x0 + largura - lTot;
    doc.save().roundedRect(xTot, yTot, lTot, hTot, 6).fill(CORES.painel).restore();
    doc.y = yTot + 12;
    for (const [r, v] of linhasTot) {
      const yl = doc.y;
      fonte('N', 10, CORES.secundario).text(r, xTot + 14, yl, { width: 110 });
      fonte('M', 10).text(v, xTot + lTot - 14 - 120, yl, { width: 120, align: 'right' });
      doc.y = yl + 16;
    }
    const yT = doc.y + (linhasTot.length ? 2 : 0);
    fonte('B', 11, CORES.texto).text('TOTAL', xTot + 14, yT + 3, { width: 100, characterSpacing: 0.8 });
    fonte('B', 16, CORES.destaque).text(p.total, xTot + lTot - 14 - 150, yT, { width: 150, align: 'right' });
    doc.y = yTot + hTot + 22;

    // ---------------- condições
    const bloco = (titulo: string, texto: string) => {
      fonte('N', 10);
      quebra(doc.heightOfString(texto, { width: largura }) + 20);
      fonte('S', 10).text(titulo, x0, doc.y, { width: largura });
      doc.y += 1;
      fonte('N', 10).text(texto, { width: largura, lineGap: 1.5 });
      doc.y += 9;
    };
    tituloSecao('Condições');
    bloco('Pagamento', p.condicoesPagamento);
    if (p.prazoEntrega) bloco('Prazo de entrega e instalação', p.prazoEntrega);
    bloco('Validade da proposta', `Até ${p.validadeAte}.`);
    if (p.observacoes) bloco('Observações', p.observacoes);
    doc.y += 8;

    // ---------------- avisos importantes (sempre no final)
    tituloSecao('Avisos importantes');
    const marcador = (texto: string, forte?: string) => {
      fonte('N', 9.5);
      quebra(doc.heightOfString(`${forte ?? ''}${texto}`, { width: largura - 14 }) + 6);
      const y = doc.y;
      doc.save().rect(x0 + 1, y + 4, 4, 4).fill(CORES.coral).restore();
      if (forte) { fonte('S', 9.5).text(forte, x0 + 14, y, { width: largura - 14, continued: true, lineGap: 1.5 }); fonte('N', 9.5).text(texto); }
      else fonte('N', 9.5).text(texto, x0 + 14, y, { width: largura - 14, lineGap: 1.5 });
      doc.y += 5;
    };
    marcador(p.garantia, 'Garantia: ');
    for (const a of p.ambientes) for (const i of a.itens) {
      fonte('N', 9.5);
      quebra(16);
      const y = doc.y;
      fonte('N', 9.5, CORES.secundario).text(`${a.nome} · ${i.titulo}: `, x0 + 26, y, { width: largura - 26, continued: true });
      fonte('M', 9.5).text(i.garantia);
      doc.y += 2;
    }
    doc.y += 5;
    if (p.avisoConferencia) marcador('Valores sujeitos à conferência técnica das medidas no local, antes da produção.', 'Medidas: ');
    marcador('Esta proposta é válida até a data indicada no topo. Depois disso, preços e prazos podem mudar.', 'Validade: ');

    // ---------------- rodapé em todas as páginas
    const paginas = doc.bufferedPageRange();
    const rodape = [p.loja.nome, p.loja.telefone, p.loja.instagram].filter(Boolean).join('  ·  ');
    for (let k = 0; k < paginas.count; k++) {
      doc.switchToPage(paginas.start + k);
      const margemAntiga = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const yR = H - 38;
      regua(yR - 8, CORES.linha, 0.6);
      fonte('N', 8, CORES.secundario).text(rodape, x0, yR, { width: largura - 90, lineBreak: false });
      fonte('N', 8, CORES.secundario).text(`Página ${k + 1} de ${paginas.count}`, x0 + largura - 90, yR, { width: 90, align: 'right', lineBreak: false });
      doc.page.margins.bottom = margemAntiga;
    }
    doc.end();
  });
}
