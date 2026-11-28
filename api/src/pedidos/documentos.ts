import PDFDocument from 'pdfkit';
import { sql } from 'drizzle-orm';
import { d } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import { formatarTelefone } from '../cadastros/validacao.js';
import { lerDocumento } from '../orcamentos/servico.js';
import { CATEGORIA_INSTALACAO, lerPedido } from './servico.js';

/**
 * PDFs do pedido para quem NÃO tem login (especificação v1.1, seção 12.3):
 *  - Ficha de corte (costureira) e pedido de fábrica (persianas): medidas e detalhes técnicos, ZERO valores.
 *  - Ordem de compra (fornecedor): materiais e quantidades, sem valores.
 *  - OS de instalação (instalador): endereço, telefone, restrições do condomínio, peças para conferir e assinatura.
 *  - Termo de aceite: o que o cliente assinou na obra, com a assinatura.
 * Nenhum desses documentos mostra custo, preço ou margem.
 */

const FUSO = 'America/Sao_Paulo';
const m2 = (v: unknown) => (v == null || v === '' ? '-' : `${d(String(v)).toFixed(2).replace('.', ',')} m`);
const num = (v: unknown, casas = 2) => (v == null || v === '' ? '-' : d(String(v)).toFixed(casas).replace('.', ','));
const qtd = (v: string, un: string) => `${un === 'UN' || un === 'PC' ? d(v).toFixed(0) : d(v).toFixed(2).replace('.', ',')} ${un}`;
export const dataHoraBR = (v: string | Date | null | undefined) => (v
  ? new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, dateStyle: 'short', timeStyle: 'short' }).format(new Date(v)) : '');
const dataBR = (v: string | null | undefined) => (v ? v.slice(0, 10).split('-').reverse().join('/') : '');

const CONFECCAO: Record<string, string> = { WAVE: 'Wave', PREGA: 'Prega macho', FRANZIDO: 'Franzido' };
const LADO: Record<string, string> = { DIREITO: 'Direito', ESQUERDO: 'Esquerdo', CENTRAL: 'Central' };
const ENROLAMENTO: Record<string, string> = { NORMAL: 'Normal (rente ao vidro)', REVERSO: 'Reverso (cascata)' };
const FIXACAO: Record<string, string> = { TETO: 'Teto', PAREDE: 'Parede' };
const MODO_VAO: Record<string, string> = { DENTRO_VAO: 'Dentro do vão', FORA_VAO: 'Fora do vão', TETO: 'No teto' };
const CORTE: Record<string, string> = { HORIZONTAL: 'Horizontal (rolo deitado, sem emenda)', VERTICAL_TIRAS: 'Vertical em tiras (com emendas)' };

// ------------------------------------------------------------------ montagem do PDF

type Doc = InstanceType<typeof PDFDocument>;
const COR = '#1f4d3f';
const CINZA = '#666666';
const X0 = 40;

class Pdf {
  doc: Doc;
  largura: number;
  private partes: Buffer[] = [];
  private fim: Promise<Buffer>;

  constructor(titulo: string, autor: string) {
    this.doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: titulo, Author: autor } });
    this.largura = this.doc.page.width - 80;
    this.fim = new Promise((ok, falha) => {
      this.doc.on('data', (b: Buffer) => this.partes.push(b));
      this.doc.on('end', () => ok(Buffer.concat(this.partes)));
      this.doc.on('error', falha);
    });
  }

  quebra(altura: number) { if (this.doc.y + altura > this.doc.page.height - 50) this.doc.addPage(); }

  cabecalho(loja: string, titulo: string, linhas: string[]) {
    const doc = this.doc;
    doc.font('Helvetica-Bold').fontSize(16).fillColor(COR).text(loja, X0, 40);
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(titulo);
    doc.font('Helvetica').fontSize(9).fillColor(CINZA);
    for (const l of linhas) doc.text(l);
    doc.moveDown(0.6);
  }

  secao(titulo: string) {
    this.quebra(50);
    const doc = this.doc;
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(11.5).fillColor(COR).text(titulo, X0, doc.y, { width: this.largura });
    doc.moveTo(X0, doc.y + 1).lineTo(X0 + this.largura, doc.y + 1).strokeColor('#dddddd').lineWidth(0.5).stroke();
    doc.moveDown(0.4);
  }

  /** Pares rótulo: valor em 2 colunas. */
  pares(lista: [string, string | null | undefined][]) {
    const doc = this.doc;
    const validos = lista.filter(([, v]) => v != null && v !== '');
    const col = this.largura / 2;
    for (let i = 0; i < validos.length; i += 2) {
      this.quebra(16);
      const y = doc.y;
      let yMax = y;
      for (const [k, [rot, val]] of validos.slice(i, i + 2).entries()) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text(`${rot}: `, X0 + k * col, y, { continued: true, width: col - 8 });
        doc.font('Helvetica').text(String(val));
        yMax = Math.max(yMax, doc.y);
      }
      doc.y = yMax;
    }
    doc.x = X0;
  }

  texto(t: string, opcoes: { negrito?: boolean; cor?: string; tamanho?: number } = {}) {
    this.quebra(16);
    this.doc.font(opcoes.negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(opcoes.tamanho ?? 9.5).fillColor(opcoes.cor ?? '#000')
      .text(t, X0, this.doc.y, { width: this.largura });
  }

  /** Tabela simples (larguras em fração da página). */
  tabela(colunas: { titulo: string; peso: number; alinhar?: 'left' | 'right' | 'center' }[], linhas: string[][], opcoes: { caixa?: boolean } = {}) {
    const doc = this.doc;
    const total = colunas.reduce((s, c) => s + c.peso, 0);
    const larg = colunas.map((c) => (c.peso / total) * this.largura);
    const desenhar = (valores: string[], negrito: boolean) => {
      const alturas = valores.map((v, i) => doc.font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).heightOfString(v, { width: larg[i]! - 6 }));
      const h = Math.max(12, ...alturas) + 4;
      this.quebra(h + 4);
      const y = doc.y;
      let x = X0;
      for (const [i, v] of valores.entries()) {
        if (opcoes.caixa && i === 0 && !negrito) doc.rect(x + 2, y + 2, 8, 8).strokeColor('#333').lineWidth(0.6).stroke();
        doc.font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor('#000')
          .text(v, x + 3, y + 2, { width: larg[i]! - 6, align: colunas[i]!.alinhar ?? 'left' });
        x += larg[i]!;
      }
      doc.moveTo(X0, y + h).lineTo(X0 + this.largura, y + h).strokeColor('#e5e5e5').lineWidth(0.4).stroke();
      doc.y = y + h + 1;
    };
    desenhar(colunas.map((c) => c.titulo), true);
    for (const l of linhas) desenhar(l, false);
    doc.x = X0;
    doc.moveDown(0.4);
  }

  alertas(lista: { severidade?: string; mensagem: string }[]) {
    for (const a of lista) {
      this.texto(`${a.severidade === 'CRITICO' ? '(!) ' : '• '}${a.mensagem}`, { cor: a.severidade === 'CRITICO' ? '#b91c1c' : '#92400e', tamanho: 8.5 });
    }
  }

  campoAssinatura(rotulo: string) {
    this.quebra(70);
    const doc = this.doc;
    doc.moveDown(2.2);
    const y = doc.y;
    doc.moveTo(X0, y).lineTo(X0 + 240, y).strokeColor('#000').lineWidth(0.6).stroke();
    doc.moveTo(X0 + 280, y).lineTo(X0 + this.largura, y).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(CINZA).text(rotulo, X0, y + 3, { width: 240 });
    doc.text('Data', X0 + 280, y + 3);
    doc.x = X0;
    doc.moveDown(0.6);
  }

  rodape(t: string) {
    this.quebra(30);
    this.doc.moveDown(0.8);
    this.texto(t, { cor: CINZA, tamanho: 8 });
  }

  fechar(): Promise<Buffer> { this.doc.end(); return this.fim; }
}

// ------------------------------------------------------------------ dados comuns

async function base(db: Banco, pedidoId: string) {
  const p = await lerPedido(db, pedidoId);
  if (!p) return null;
  const doc = (await lerDocumento(db, p.orcamentoId))!;
  const [loja] = (await db.execute(sql`SELECT nome FROM lojas WHERE id = ${p.lojaId}`)).rows as { nome: string }[];
  // Categoria de cada SKU (para separar serviço de instalação e mão de obra).
  const cats = (await db.execute(sql`SELECT sku, categoria_id AS categoria FROM produtos`)).rows as { sku: string; categoria: number }[];
  const categoria = new Map(cats.map((c) => [c.sku, Number(c.categoria)]));
  return { p, itens: doc.itens, observacoesCliente: doc.c.observacoesCliente, loja: loja?.nome ?? 'Loja', categoria };
}

type Esp = Record<string, unknown>;
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Esp) : {});

function linhasPedido(p: NonNullable<Awaited<ReturnType<typeof base>>>['p']) {
  return [
    `Pedido ${p.numero}${p.titulo ? ` · ${p.titulo}` : ''} · Cliente: ${p.clienteNome}`,
    `Emitido em ${dataHoraBR(new Date())}${p.previsaoEntrega ? ` · Entrega prevista: ${dataBR(p.previsaoEntrega)}` : ''}`,
  ];
}

// ------------------------------------------------------------------ ficha de corte e pedido de fábrica

/** Ficha de corte da costureira (cortinas) ou pedido de fábrica (persianas). Sem nenhum valor. */
export async function pdfProducao(db: Banco, pedidoId: string, tipo: 'CORTINA' | 'PERSIANA'): Promise<Buffer | null> {
  const b = await base(db, pedidoId);
  if (!b) return null;
  const itens = b.itens.filter((i) => i.tipo === tipo);
  const titulo = tipo === 'CORTINA' ? 'Ficha de corte (costureira)' : 'Pedido de fábrica (persianas)';
  const pdf = new Pdf(`${titulo} ${b.p.numero}`, b.loja);
  pdf.cabecalho(b.loja, titulo, linhasPedido(b.p));
  if (itens.length === 0) pdf.texto(`Este pedido não tem ${tipo === 'CORTINA' ? 'cortinas' : 'persianas'}.`);

  for (const [n, i] of itens.entries()) {
    const e = obj(i.entrada);
    const esp = obj(i.especificacaoTecnica);
    pdf.secao(`${n + 1}. ${i.ambiente}: ${i.descricaoComercial}`);
    if (tipo === 'CORTINA') {
      const tec = obj(esp.tecido);
      const forro = obj(esp.forro);
      const trilho = obj(esp.trilho);
      const barras = (Array.isArray(trilho.barras) ? trilho.barras : []) as { tamanhoM: string; quantidade: number }[];
      pdf.pares([
        ['Largura do trilho', m2(e.larguraTrilho)], ['Altura pronta', m2(e.alturaPronta)],
        ['Folhas', String(e.numFolhas ?? '-')], ['Confecção', CONFECCAO[String(e.confeccao)] ?? String(e.confeccao ?? '-')],
        ['Cortineiro (profundidade)', e.profundidadeCortineiroM ? m2(e.profundidadeCortineiroM) : null],
        ['Trilho', trilho.sku ? `${trilho.sku}${trilho.vias ? ` · ${trilho.vias} via(s)` : ''}${trilho.varao ? ' · varão' : ''}` : null],
        ['Trilho motorizado', obj(esp.trilhoMotorizado).sku ? `${obj(esp.trilhoMotorizado).sku} · ${obj(esp.trilhoMotorizado).modelo ?? ''} ${obj(esp.trilhoMotorizado).cor ?? ''} · faixa até ${num(obj(esp.trilhoMotorizado).faixaAteM)} m` : null],
        ['Barras', barras.length ? barras.map((x) => `${x.quantidade}x ${num(x.tamanhoM)} m`).join(' + ') : null],
      ]);
      const camada = (rot: string, c: Esp, ent: Esp) => [
        rot, String(c.sku ?? '-'), `${num(c.larguraRolo)} m`, num(c.fator, 2), CORTE[String(c.modoCorte)] ?? String(c.modoCorte ?? '-'),
        `${num(c.alturaCorte)} m`, c.numTiras ? String(c.numTiras) : '-', `${num(ent.margemBarra ?? (rot === 'Tecido' ? '0.30' : '0.20'))} m`, `${num(c.consumoML)} m`,
      ];
      const linhas = [camada('Tecido', tec, obj(e.tecido))];
      if (forro.sku) linhas.push(camada('Forro', forro, obj(e.forro)));
      pdf.tabela([
        { titulo: 'Camada', peso: 1.1 }, { titulo: 'SKU', peso: 1 }, { titulo: 'Rolo', peso: 0.8 }, { titulo: 'Fator', peso: 0.7 },
        { titulo: 'Corte', peso: 2.2 }, { titulo: 'Alt. corte', peso: 0.9 }, { titulo: 'Tiras', peso: 0.6 },
        { titulo: 'Cab.+barra', peso: 1 }, { titulo: 'Consumo', peso: 0.9 },
      ], linhas);
      const descForro = obj(e.forro).desconto;
      if (forro.sku && descForro) pdf.texto(`Forro ${num(descForro)} m mais curto que o tecido.`, { tamanho: 8.5 });
    } else {
      const vao = obj(esp.vaoBruto);
      pdf.pares([
        ['Medida de produção (L x A)', `${m2(i.larguraProducao)} x ${m2(i.alturaProducao)}`],
        ['Vão bruto', vao.largura ? `${m2(vao.largura)} x ${m2(vao.altura)}${vao.modo ? ` · ${MODO_VAO[String(vao.modo)] ?? vao.modo}` : ''}` : null],
        ['Peças', String(esp.numPecas ?? 1)], ['Produto', String(esp.sku ?? '-')],
        ['Acionamento', esp.acionamento === 'MOTORIZADO' ? 'Motorizado' : 'Manual'],
        ['Modelo de acionamento', esp.modeloAcionamento ? String(esp.modeloAcionamento) : null],
        ['Opcionais', Array.isArray(esp.adicionais) && esp.adicionais.length ? esp.adicionais.join(', ') : null],
        ['Lado do comando', LADO[String(esp.ladoComando)] ?? String(esp.ladoComando ?? '-')],
        ['Enrolamento', ENROLAMENTO[String(esp.sentidoEnrolamento)] ?? String(esp.sentidoEnrolamento ?? '-')],
        ['Fixação', FIXACAO[String(esp.fixacao)] ?? (esp.fixacao ? String(esp.fixacao) : 'Não informada')],
        ['Tubo mínimo', String(esp.tuboMinimoRecomendado ?? '-')],
        [String(esp.rotuloBando ?? 'Bandô'), esp.bando ? (esp.bandoSku ? `Sim (${String(esp.bandoSku)})` : 'Sim') : 'Não'], ['Guia lateral', esp.guiaLateral ? 'Sim' : 'Não'], ['Calha inferior', esp.calhaInferior ? 'Sim' : 'Não'],
      ]);
    }
    const materiais = i.componentes.filter((c) => b.categoria.get(c.sku) !== CATEGORIA_INSTALACAO);
    if (materiais.length) {
      pdf.texto('Materiais', { negrito: true, tamanho: 9 });
      pdf.tabela([{ titulo: 'SKU', peso: 1 }, { titulo: 'Descrição', peso: 4 }, { titulo: 'Quantidade', peso: 1.2, alinhar: 'right' }],
        materiais.map((c) => [c.sku, c.descricao, qtd(c.quantidade, c.unidade)]));
    }
    const alertas = (Array.isArray(i.alertas) ? i.alertas : []) as { severidade?: string; mensagem: string }[];
    if (alertas.length) pdf.alertas(alertas);
  }
  pdf.rodape('Documento de produção: confira as medidas antes de cortar. Dúvidas, fale com a loja antes de iniciar.');
  return pdf.fechar();
}

// ------------------------------------------------------------------ ordem de compra

export async function pdfOrdemCompra(db: Banco, ordemId: string): Promise<{ pdf: Buffer; numero: string; pedidoId: string } | null> {
  const [o] = (await db.execute(sql`
    SELECT o.numero, o.pedido_id AS "pedidoId", o.tipo, o.status, to_char(o.previsao_entrega, 'YYYY-MM-DD') AS "previsaoEntrega", o.observacoes,
           o.criado_em AS "criadoEm", f.nome_fantasia AS fornecedor, f.telefone, f.whatsapp, a.numero AS "aditivoNumero"
      FROM ordens_compra o LEFT JOIN fornecedores f ON f.id = o.fornecedor_id LEFT JOIN pedido_aditivos a ON a.id = o.aditivo_id
     WHERE o.id = ${ordemId}`)).rows as {
    numero: string; pedidoId: string; tipo: string; status: string; previsaoEntrega: string | null; observacoes: string | null;
    criadoEm: string; fornecedor: string | null; telefone: string | null; whatsapp: string | null; aditivoNumero: number | null;
  }[];
  if (!o) return null;
  const b = await base(db, o.pedidoId);
  if (!b) return null;
  const itens = (await db.execute(sql`
    SELECT sku, descricao, unidade, quantidade::text AS quantidade, ambiente FROM ordem_compra_itens WHERE ordem_id = ${ordemId} ORDER BY ordem`)).rows as
    { sku: string; descricao: string; unidade: string; quantidade: string; ambiente: string | null }[];
  const pdf = new Pdf(`Ordem de compra ${o.numero}`, b.loja);
  const titulo = o.tipo === 'COSTURA' ? 'Ordem de costura' : o.tipo === 'FABRICA' ? 'Pedido à fábrica' : 'Ordem de compra';
  pdf.cabecalho(b.loja, `${titulo} ${o.numero}`, [
    `Fornecedor: ${o.fornecedor ?? 'a definir'}${o.whatsapp || o.telefone ? ` · ${formatarTelefone(o.whatsapp ?? o.telefone ?? '')}` : ''}`,
    `Referente ao pedido ${b.p.numero} (${b.p.clienteNome})${o.aditivoNumero ? ` · complemento do aditivo ${o.aditivoNumero}` : ''}`,
    `Emitida em ${dataHoraBR(o.criadoEm)}${o.previsaoEntrega ? ` · Entrega combinada: ${dataBR(o.previsaoEntrega)}` : ''}`,
  ]);
  pdf.tabela([
    { titulo: 'SKU', peso: 1 }, { titulo: 'Descrição', peso: 3.6 }, { titulo: 'Ambiente', peso: 1.6 }, { titulo: 'Quantidade', peso: 1.2, alinhar: 'right' },
  ], itens.map((i) => [i.sku, i.descricao, i.ambiente ?? '', qtd(i.quantidade, i.unidade)]));
  if (o.observacoes) { pdf.secao('Observações'); pdf.texto(o.observacoes); }
  if (o.tipo === 'COSTURA') pdf.texto('As medidas de corte estão na ficha de corte que acompanha esta ordem.', { cor: CINZA, tamanho: 8.5 });
  if (o.tipo === 'FABRICA') pdf.texto('Medidas e detalhes de cada persiana no pedido de fábrica que acompanha esta ordem.', { cor: CINZA, tamanho: 8.5 });
  return { pdf: await pdf.fechar(), numero: o.numero, pedidoId: o.pedidoId };
}

// ------------------------------------------------------------------ OS de instalação

export async function pdfOrdemServico(db: Banco, pedidoId: string): Promise<Buffer | null> {
  const b = await base(db, pedidoId);
  if (!b) return null;
  const p = b.p;
  const pdf = new Pdf(`OS de instalação ${p.numero}`, b.loja);
  pdf.cabecalho(b.loja, `Ordem de serviço de instalação · ${p.numero}`, [
    `Emitida em ${dataHoraBR(new Date())}`,
  ]);
  pdf.secao('Cliente e local');
  pdf.pares([
    ['Cliente', p.clienteNome], ['Telefone', formatarTelefone(p.clienteTelefone)],
    ['Endereço', p.clienteEndereco ?? 'Não informado'], ['Projeto', p.titulo],
  ]);
  if (p.clienteObsAcesso) pdf.texto(`Acesso e regras do condomínio: ${p.clienteObsAcesso}`, { negrito: true, cor: '#92400e' });
  pdf.secao('Agenda');
  pdf.pares([
    ['Data e hora', p.instalacaoAgendada ? dataHoraBR(p.instalacaoAgendada) : 'A agendar'],
    ['Duração prevista', p.duracaoHoras ? `${num(p.duracaoHoras, 1)} h` : null],
    ['Instalador', p.instaladorNome ?? 'A definir'],
    ['Vendedor', p.vendedorNome],
  ]);
  if (p.obsInstalacao) pdf.texto(`Observações: ${p.obsInstalacao}`);

  pdf.secao('O que instalar (por ambiente)');
  for (const [n, i] of b.itens.entries()) {
    const esp = obj(i.especificacaoTecnica);
    if (i.tipo === 'SERVICO') {
      pdf.texto(`${n + 1}. ${i.ambiente}: ${i.descricaoComercial}`, { negrito: true });
      pdf.texto('Serviço (sem peça nova da loja).', { tamanho: 8.5, cor: CINZA });
      continue;
    }
    const detalhes = i.tipo === 'PERSIANA'
      ? [esp.acionamento === 'MOTORIZADO' ? 'motorizada' : 'manual', esp.ladoComando ? `comando ${String(LADO[String(esp.ladoComando)] ?? esp.ladoComando).toLowerCase()}` : null,
        esp.fixacao ? `fixação no(a) ${String(FIXACAO[String(esp.fixacao)] ?? esp.fixacao).toLowerCase()}` : null, Number(esp.numPecas ?? 1) > 1 ? `${esp.numPecas} peças` : null]
      : [`${obj(i.entrada).numFolhas ?? 1} folha(s)`, CONFECCAO[String(obj(i.entrada).confeccao)] ?? null];
    pdf.texto(`${n + 1}. ${i.ambiente}: ${i.descricaoComercial}`, { negrito: true });
    pdf.texto(`Medida: ${m2(i.larguraProducao)} x ${m2(i.alturaProducao)} · ${detalhes.filter(Boolean).join(' · ')}`, { tamanho: 8.5, cor: CINZA });
    const alertas = ((Array.isArray(i.alertas) ? i.alertas : []) as { severidade?: string; mensagem: string; codigo?: string }[])
      .filter((a) => a.severidade !== 'INFO');
    if (alertas.length) pdf.alertas(alertas);
  }

  pdf.secao('Peças para conferir no carro antes de sair');
  const linhas: string[][] = [];
  for (const i of b.itens) {
    if (i.tipo === 'SERVICO') continue;
    linhas.push(['', `${i.ambiente}: ${i.tipo === 'CORTINA' ? 'cortina pronta' : 'persiana'} ${m2(i.larguraProducao)} x ${m2(i.alturaProducao)}`, '1']);
    for (const c of i.componentes) {
      const cat = b.categoria.get(c.sku);
      // Tecido e mão de obra já vêm dentro da cortina pronta; serviço não é peça.
      if (cat === CATEGORIA_INSTALACAO || cat === 1 || cat === 5) continue;
      if (i.tipo === 'PERSIANA' && cat === 6) continue;
      linhas.push(['', `   ${c.descricao} (${c.sku})`, qtd(c.quantidade, c.unidade)]);
    }
  }
  pdf.tabela([{ titulo: 'OK', peso: 0.5 }, { titulo: 'Peça', peso: 6 }, { titulo: 'Qtd.', peso: 1.2, alinhar: 'right' }], linhas, { caixa: true });

  pdf.secao('Aceite do cliente');
  pdf.texto('Declaro que os itens acima foram instalados e conferidos, e que recebi as orientações de uso.', { tamanho: 9 });
  pdf.campoAssinatura('Assinatura do cliente (nome legível)');
  pdf.campoAssinatura('Instalador');
  pdf.rodape('O aceite também pode ser assinado na tela do aparelho do vendedor (vale como esta assinatura).');
  return pdf.fechar();
}

// ------------------------------------------------------------------ termo de aceite (assinado na obra)

export async function pdfTermoAceite(db: Banco, pedidoId: string): Promise<Buffer | null> {
  const b = await base(db, pedidoId);
  if (!b) return null;
  const [a] = (await db.execute(sql`
    SELECT nome_recebedor AS nome, documento_recebedor AS documento, assinatura_png AS png, checklist, observacoes, ressalvas,
           assinado_em AS "assinadoEm", offline FROM pedido_aceites WHERE pedido_id = ${pedidoId}`)).rows as {
    nome: string; documento: string | null; png: Buffer; checklist: { descricao: string; ok: boolean }[]; observacoes: string | null;
    ressalvas: boolean; assinadoEm: string; offline: boolean;
  }[];
  if (!a) return null;
  const p = b.p;
  const pdf = new Pdf(`Termo de aceite ${p.numero}`, b.loja);
  pdf.cabecalho(b.loja, `Termo de aceite da instalação · ${p.numero}`, [
    `Cliente: ${p.clienteNome}${p.clienteEndereco ? ` · ${p.clienteEndereco}` : ''}`,
    `Assinado em ${dataHoraBR(a.assinadoEm)}${a.offline ? ' (registrado no aparelho sem internet)' : ''}`,
  ]);
  pdf.secao('Itens conferidos');
  pdf.tabela([{ titulo: 'Item', peso: 6 }, { titulo: 'Conferido', peso: 1.2, alinhar: 'center' }],
    (a.checklist ?? []).map((c) => [c.descricao, c.ok ? 'Sim' : 'NÃO']));
  if (a.ressalvas) pdf.texto('O cliente aceitou com ressalvas (itens marcados como NÃO).', { negrito: true, cor: '#b91c1c' });
  if (a.observacoes) { pdf.secao('Observações'); pdf.texto(a.observacoes); }
  pdf.secao('Assinatura');
  pdf.texto('Declaro que os itens acima foram instalados e conferidos, e que recebi as orientações de uso.', { tamanho: 9 });
  pdf.quebra(130);
  const y = pdf.doc.y + 6;
  try { pdf.doc.image(a.png, X0, y, { fit: [260, 100] }); } catch { /* assinatura ilegível: segue sem a imagem */ }
  pdf.doc.y = y + 104;
  pdf.doc.moveTo(X0, pdf.doc.y).lineTo(X0 + 260, pdf.doc.y).strokeColor('#000').lineWidth(0.6).stroke();
  pdf.doc.moveDown(0.3);
  pdf.texto(`${a.nome}${a.documento ? ` · Documento ${a.documento}` : ''}`, { tamanho: 9 });
  return pdf.fechar();
}
