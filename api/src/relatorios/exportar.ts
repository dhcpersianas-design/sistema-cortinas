import { crc32, deflateRawSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import type { Celula, Coluna, Linha, Relatorio, TipoColuna } from './tipos.js';

/** Exporta um relatório (mesma estrutura da tela) para PDF e para planilha XLSX, sem dependências extras. */

const FUSO = 'America/Sao_Paulo';
const COR = '#1f4d3f';
const VERMELHO = '#b42318';

function milhar(s: string): string {
  const neg = s.startsWith('-');
  const [i, dec] = (neg ? s.slice(1) : s).split('.');
  return `${neg ? '-' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${dec !== undefined ? `,${dec}` : ''}`;
}

/** Valores já vêm com 2 casas (texto decimal); o Number é só para algo fora do padrão. */
const duasCasas = (s: string) => (/^-?\d+\.\d{2}$/.test(s) ? s : Number(s).toFixed(2));

export function formatar(v: Celula | boolean | undefined, tipo: TipoColuna): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  const s = String(v);
  switch (tipo) {
    case 'moeda': return `R$ ${milhar(duasCasas(s))}`;
    case 'pct': return `${milhar(duasCasas(s))}%`;
    case 'int': return milhar(String(v));
    case 'data': return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10).split('-').reverse().join('/') : s;
    default: return s;
  }
}

const geradoEm = (r: Relatorio) => new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, dateStyle: 'short', timeStyle: 'short' }).format(new Date(r.geradoEm));

// ------------------------------------------------------------------ PDF

export function relatorioPdf(r: Relatorio, loja: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, info: { Title: r.titulo, Author: loja } });
  const partes: Buffer[] = [];
  const fim = new Promise<Buffer>((ok, falha) => {
    doc.on('data', (b: Buffer) => partes.push(b));
    doc.on('end', () => ok(Buffer.concat(partes)));
    doc.on('error', falha);
  });
  const X0 = 32;
  const largura = doc.page.width - 64;
  const limite = () => doc.page.height - 40;
  const quebra = (h: number) => { if (doc.y + h > limite()) doc.addPage(); };

  doc.font('Helvetica-Bold').fontSize(14).fillColor(COR).text(loja, X0, 32);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text(r.titulo);
  doc.font('Helvetica').fontSize(8.5).fillColor('#666').text(`${r.periodo} · gerado em ${geradoEm(r)}`);
  doc.moveDown(0.6);

  if (r.resumo.length) {
    const n = Math.min(r.resumo.length, 6);
    const w = largura / n;
    let i = 0;
    for (const k of r.resumo) {
      if (i % n === 0) { quebra(34); if (i > 0) doc.y += 30; }
      const x = X0 + (i % n) * w;
      const y = doc.y;
      doc.font('Helvetica').fontSize(7.5).fillColor('#666').text(k.rotulo, x, y, { width: w - 6 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(k.alerta ? VERMELHO : '#000').text(formatar(k.valor, k.tipo), x, y + 10, { width: w - 6 });
      doc.y = y;
      i++;
    }
    doc.y += 34;
    doc.x = X0;
  }

  for (const t of r.tabelas) {
    quebra(40);
    if (t.titulo) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COR).text(t.titulo, X0, doc.y, { width: largura });
      doc.moveDown(0.2);
    }
    const pesos = t.colunas.map((c) => c.peso ?? (c.tipo === 'texto' ? 1.4 : 1));
    const somaPesos = pesos.reduce((a, b) => a + b, 0);
    const larg = pesos.map((p) => (largura * p) / somaPesos);
    const cabecalho = () => {
      doc.font('Helvetica-Bold').fontSize(7.5);
      const h = Math.max(...t.colunas.map((c, k) => doc.heightOfString(c.titulo, { width: larg[k]! - 6 }))) + 6;
      quebra(h + 12);
      const y = doc.y;
      doc.rect(X0, y, largura, h).fill('#eef3f1');
      let x = X0;
      t.colunas.forEach((c, k) => {
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#333')
          .text(c.titulo, x + 3, y + 3, { width: larg[k]! - 6, align: c.tipo === 'texto' || c.tipo === 'data' ? 'left' : 'right' });
        x += larg[k]!;
      });
      doc.y = y + h + 1;
    };
    const linha = (l: Linha, total = false) => {
      const textos = t.colunas.map((c) => formatar(l[c.chave] as Celula, c.tipo));
      doc.font(total || l._nivel === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
      const alturas = textos.map((s, k) => doc.heightOfString(s || ' ', { width: larg[k]! - 6 }));
      const h = Math.max(11, ...alturas) + 3;
      if (doc.y + h > limite()) { doc.addPage(); cabecalho(); }
      const y = doc.y;
      if (total) doc.rect(X0, y, largura, h).fill('#f4f4f4');
      let x = X0;
      t.colunas.forEach((c, k) => {
        const recuo = c.chave === t.colunas[0]!.chave && l._nivel === 1 ? 10 : 0;
        doc.font(total || l._nivel === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(l._alerta ? VERMELHO : '#000')
          .text(textos[k]!, x + 3 + recuo, y + 2, { width: larg[k]! - 6 - recuo, align: c.tipo === 'texto' || c.tipo === 'data' ? 'left' : 'right' });
        x += larg[k]!;
      });
      doc.moveTo(X0, y + h).lineTo(X0 + largura, y + h).strokeColor('#e5e5e5').lineWidth(0.4).stroke();
      doc.y = y + h;
    };
    cabecalho();
    if (!t.linhas.length) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666').text(t.vazio ?? 'Sem dados.', X0 + 3, doc.y + 2);
      doc.moveDown(0.3);
    }
    for (const l of t.linhas) linha(l);
    if (t.total) linha(t.total, true);
    doc.x = X0;
    doc.moveDown(0.8);
  }
  if (r.observacoes.length) {
    quebra(30);
    doc.font('Helvetica').fontSize(7.5).fillColor('#666');
    for (const o of r.observacoes) doc.text(`• ${o}`, X0, doc.y, { width: largura });
  }
  doc.end();
  return fim;
}

// ------------------------------------------------------------------ XLSX (Office Open XML, escrito à mão)

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // caracteres de controle não são aceitos no XML
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function colLetra(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Estilos (styles.xml): 0 normal, 1 negrito, 2 moeda, 3 %, 4 inteiro, 5 data, 6 título, 7 cabeçalho, +8 = vermelho, +13 = negrito. */
const ESTILO: Record<TipoColuna, number> = { texto: 0, moeda: 2, pct: 3, int: 4, data: 5 };

function celula(ref: string, v: Celula | boolean | undefined, tipo: TipoColuna, estilo: number): string {
  if (v === null || v === undefined || v === '') return '';
  if (tipo === 'moeda' || tipo === 'int' || tipo === 'pct') {
    const n = Number(v);
    if (Number.isFinite(n)) return `<c r="${ref}" s="${estilo}"><v>${tipo === 'pct' ? n / 100 : n}</v></c>`;
  }
  if (tipo === 'data' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const serial = (Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86_400_000;
    return `<c r="${ref}" s="${estilo}"><v>${serial}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr" s="${estilo}"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

export function relatorioXlsx(r: Relatorio, loja: string): Buffer {
  const linhasXml: string[] = [];
  let n = 0;
  const maxCols = Math.max(2, ...r.tabelas.map((t) => t.colunas.length));
  const larguras = Array.from({ length: maxCols }, () => 10);
  const linhaXml = (cels: string[]) => { n++; linhasXml.push(`<row r="${n}">${cels.join('')}</row>`); };
  const texto = (col: number, s: string, estilo = 0) => celula(`${colLetra(col)}${n + 1}`, s, 'texto', estilo);

  linhaXml([texto(0, `${loja} - ${r.titulo}`, 6)]);
  linhaXml([texto(0, `${r.periodo} · gerado em ${geradoEm(r)}`)]);
  linhaXml([]);
  for (const k of r.resumo) linhaXml([texto(0, k.rotulo, 1), celula(`B${n + 1}`, k.valor, k.tipo, ESTILO[k.tipo] + (k.alerta ? 8 : 0))]);
  if (r.resumo.length) linhaXml([]);

  for (const t of r.tabelas) {
    if (t.titulo) linhaXml([texto(0, t.titulo, 6)]);
    linhaXml(t.colunas.map((c, i) => texto(i, c.titulo, 7)));
    t.colunas.forEach((c, i) => { larguras[i] = Math.max(larguras[i]!, Math.min(60, c.titulo.length + 2)); });
    const escrever = (l: Linha, negrito: boolean) => {
      linhaXml(t.colunas.map((c: Coluna, i) => {
        const v = l[c.chave] as Celula;
        const s = formatar(v, c.tipo);
        larguras[i] = Math.max(larguras[i]!, Math.min(60, s.length + 2 + (l._nivel === 1 && i === 0 ? 2 : 0)));
        const base = c.tipo === 'texto' ? (negrito ? 1 : 0) : ESTILO[c.tipo] + (negrito ? 13 : 0);
        const estilo = l._alerta && c.tipo === 'texto' ? (negrito ? 9 : 8) : l._alerta && !negrito ? base + 8 : base;
        const valor = c.tipo === 'texto' && l._nivel === 1 && i === 0 ? `   ${v ?? ''}` : v;
        return celula(`${colLetra(i)}${n + 1}`, valor, c.tipo, estilo);
      }));
    };
    if (!t.linhas.length) linhaXml([texto(0, t.vazio ?? 'Sem dados.')]);
    for (const l of t.linhas) escrever(l, l._nivel === 0);
    if (t.total) escrever(t.total, true);
    linhaXml([]);
  }
  for (const o of r.observacoes) linhaXml([texto(0, o)]);

  const cols = larguras.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const planilha = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${linhasXml.join('')}</sheetData></worksheet>`;
  // numFmt 164 = moeda R$, 10 = 0.00%, 3 = #,##0, 14 = data
  const xf = (fmt: number, font: number) => `<xf numFmtId="${fmt}" fontId="${font}" fillId="0" borderId="0" applyNumberFormat="1" applyFont="1"/>`;
  const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00;[Red]\\-&quot;R$&quot;\\ #,##0.00"/></numFmts>
<fonts count="5"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font>
<font><b/><sz val="12"/><color rgb="FF1F4D3F"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FFB42318"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><color rgb="FFB42318"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEEF3F1"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="19">${[
    xf(0, 0), xf(0, 1), xf(164, 0), xf(10, 0), xf(3, 0), xf(14, 0), xf(0, 2),
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/>',
    xf(0, 3), xf(0, 4), xf(164, 3), xf(10, 3), xf(3, 3), xf(14, 3),
    xf(0, 1), xf(164, 1), xf(10, 1), xf(3, 1), xf(14, 1),
  ].join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const arquivos: [string, string][] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Relatorio" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', estilos],
    ['xl/worksheets/sheet1.xml', planilha],
  ];
  return zip(arquivos.map(([nome, conteudo]) => [nome, Buffer.from(conteudo, 'utf-8')]));
}

/** ZIP mínimo (deflate), suficiente para o XLSX. */
function zip(arquivos: [string, Buffer][]): Buffer {
  const locais: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [nome, dados] of arquivos) {
    const nomeB = Buffer.from(nome, 'utf-8');
    const comp = deflateRawSync(dados);
    const crc = crc32(dados);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(dados.length, 22); h.writeUInt16LE(nomeB.length, 26); h.writeUInt16LE(0, 28);
    locais.push(h, nomeB, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(dados.length, 24); c.writeUInt16LE(nomeB.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, nomeB);
    offset += 30 + nomeB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(0, 4); fim.writeUInt16LE(0, 6); fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10); fim.writeUInt32LE(cd.length, 12); fim.writeUInt32LE(offset, 16); fim.writeUInt16LE(0, 20);
  return Buffer.concat([...locais, cd, fim]);
}
