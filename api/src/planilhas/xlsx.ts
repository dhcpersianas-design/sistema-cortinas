import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Planilhas Excel (.xlsx) sem dependências extras: um ZIP mínimo e o XML do
 * Office Open XML escritos/lidos à mão. A leitura cobre o que o Excel, o
 * LibreOffice e o Google Planilhas gravam (textos compartilhados, texto
 * em linha, números e fórmulas com valor calculado).
 */

export class ErroPlanilha extends Error {}

// ------------------------------------------------------------------ ZIP

/** ZIP mínimo (deflate), suficiente para o XLSX. */
export function zip(arquivos: [string, Buffer][]): Buffer {
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

const LIMITE_DESCOMPACTADO = 40 * 1024 * 1024;

/** Lê os arquivos de um ZIP pelo diretório central (aceita "data descriptor"). */
export function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ErroPlanilha('O arquivo não é uma planilha Excel (.xlsx) válida.');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const saida = new Map<string, Buffer>();
  let soma = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ErroPlanilha('Planilha corrompida (índice do ZIP).');
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const tamNome = buf.readUInt16LE(p + 28);
    const tamExtra = buf.readUInt16LE(p + 30);
    const tamComent = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nome = buf.subarray(p + 46, p + 46 + tamNome).toString('utf-8');
    p += 46 + tamNome + tamExtra + tamComent;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new ErroPlanilha('Planilha corrompida (arquivo interno).');
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const dados = buf.subarray(ini, ini + tamComp);
    if (!/\.(xml|rels)$/i.test(nome)) continue; // imagens etc. não interessam
    let conteudo: Buffer;
    try {
      conteudo = metodo === 0 ? Buffer.from(dados)
        : metodo === 8 ? inflateRawSync(dados, { maxOutputLength: LIMITE_DESCOMPACTADO - soma })
          : (() => { throw new ErroPlanilha('Planilha com compactação não suportada.'); })();
    } catch (e) {
      if (e instanceof ErroPlanilha) throw e;
      throw new ErroPlanilha('Planilha grande demais ou corrompida.');
    }
    soma += conteudo.length;
    saida.set(nome.replace(/^\/+/, ''), conteudo);
  }
  return saida;
}

// ------------------------------------------------------------------ Leitura

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function desescapar(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]!);
}

function atributos(tag: string): Record<string, string> {
  const a: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) a[m[1]!.replace(/^.*:/, (x) => (x === 'r:' ? 'r:' : ''))] = desescapar(m[3] ?? m[4] ?? '');
  return a;
}

/** Junta os <t> de um trecho (texto rico vem em vários <r><t>), ignorando a fonética <rPh>. */
function textos(xml: string): string {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)]
    .map((m) => desescapar(m[1] ?? '')).join('');
}

function colunaIndice(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Número do Excel sem o ruído de ponto flutuante (12.300000000000001 → "12.3"). */
function numeroLimpo(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const s = String(Number(n.toPrecision(15)));
  return /e/i.test(s) ? n.toFixed(6).replace(/\.?0+$/, '') : s;
}

export type Celula = { texto: string; numero: boolean };
export type Aba = { nome: string; linhas: Celula[][] };

/** Lê todas as abas de um .xlsx. Números voltam com ponto decimal e marcados como número. */
export function lerXlsx(buf: Buffer): Aba[] {
  const arq = unzip(buf);
  const ler = (n: string) => arq.get(n)?.toString('utf-8');
  const workbook = ler('xl/workbook.xml');
  if (!workbook) throw new ErroPlanilha('O arquivo não é uma planilha Excel (.xlsx) válida.');
  const rels = new Map<string, string>();
  for (const m of (ler('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const a = atributos(m[0]);
    if (a.Id && a.Target) rels.set(a.Id, a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target}`);
  }
  const compartilhados = [...(ler('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g)].map((m) => textos(m[1] ?? ''));
  const abas: Aba[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const a = atributos(m[0]);
    const caminho = rels.get(a['r:id'] ?? a.id ?? '');
    const xml = caminho ? ler(caminho) : undefined;
    if (!xml) continue;
    const linhas: Celula[][] = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const numLinha = Number(atributos(`<x ${r[1]}>`).r) || linhas.length + 1;
      const linha: Celula[] = [];
      let col = 0;
      for (const c of r[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const at = atributos(`<x ${c[1]}>`);
        if (at.r) col = colunaIndice(at.r);
        const corpo = c[2] ?? '';
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
        let cel: Celula = { texto: '', numero: false };
        if (at.t === 's') cel = { texto: compartilhados[Number(v)] ?? '', numero: false };
        else if (at.t === 'inlineStr') cel = { texto: textos(corpo), numero: false };
        else if (at.t === 'str' || at.t === 'e') cel = { texto: desescapar(v ?? ''), numero: false };
        else if (at.t === 'b') cel = { texto: v === '1' ? 'SIM' : 'NÃO', numero: false };
        else if (v !== undefined) cel = { texto: numeroLimpo(desescapar(v)), numero: true };
        linha[col] = cel;
        col++;
      }
      for (let i = 0; i < linha.length; i++) linha[i] ??= { texto: '', numero: false };
      linhas[numLinha - 1] = linha;
    }
    for (let i = 0; i < linhas.length; i++) linhas[i] ??= [];
    abas.push({ nome: a.name ?? `Aba ${abas.length + 1}`, linhas });
  }
  if (!abas.length) throw new ErroPlanilha('A planilha não tem nenhuma aba com dados.');
  return abas;
}

// ------------------------------------------------------------------ Escrita

export const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

export function colLetra(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export type AbaEscrita = {
  nome: string;
  /** Primeira linha = cabeçalho (negrito, fundo, congelado), salvo `semCabecalho`. */
  linhas: (string | number | null | undefined)[][];
  larguras?: number[];
  semCabecalho?: boolean;
};

/** Planilha simples com várias abas. Estilos: 0 normal, 1 cabeçalho, 2 número 0,00 (até 4 casas), 3 título. */
export function escreverXlsx(abas: AbaEscrita[]): Buffer {
  const folhas = abas.map((aba) => {
    const linhas = aba.linhas.map((l, i) => {
      const cab = i === 0 && !aba.semCabecalho;
      const cels = l.map((v, j) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = `${colLetra(j)}${i + 1}`;
        if (typeof v === 'number' && !cab) return `<c r="${ref}" s="2"><v>${v}</v></c>`;
        const estilo = cab ? 1 : aba.semCabecalho && i === 0 ? 3 : 0;
        return `<c r="${ref}" t="inlineStr" s="${estilo}"><is><t xml:space="preserve">${escXml(String(v))}</t></is></c>`;
      }).join('');
      return `<row r="${i + 1}">${cels}</row>`;
    }).join('');
    const cols = (aba.larguras ?? []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const congelar = aba.semCabecalho ? '' : '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${congelar}${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${linhas}</sheetData></worksheet>`;
  });
  const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00##"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="13"/><color rgb="FF1F4D3F"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEEF3F1"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const overrides = folhas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const arquivos: [string, string][] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      abas.map((a, i) => `<sheet name="${escXml(a.nome.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      folhas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    }<Relationship Id="rId${folhas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', estilos],
    ...folhas.map((f, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, f]),
  ];
  return zip(arquivos.map(([nome, conteudo]) => [nome, Buffer.from(conteudo, 'utf-8')]));
}

// ------------------------------------------------------------------ CSV

/** Texto do CSV: UTF-8 (com ou sem BOM) ou, se não for UTF-8 válido, Windows-1252 (Excel em português). */
export function decodificarTexto(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** CSV com ";" (Excel em português) ou ",", aspas e quebras de linha dentro de aspas. */
export function lerCsv(texto: string): Celula[][] {
  const primeira = texto.split(/\r?\n/, 1)[0] ?? '';
  const sep = (primeira.match(/;/g)?.length ?? 0) >= (primeira.match(/,/g)?.length ?? 0) ? ';' : primeira.includes('\t') && !primeira.includes(',') ? '\t' : ',';
  const linhas: Celula[][] = [];
  let linha: Celula[] = [];
  let campo = '';
  let aspas = false;
  const fecharCampo = () => { linha.push({ texto: campo, numero: false }); campo = ''; };
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]!;
    if (aspas) {
      if (ch === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += ch;
    } else if (ch === '"' && campo === '') aspas = true;
    else if (ch === sep) fecharCampo();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      fecharCampo(); linhas.push(linha); linha = [];
    } else campo += ch;
  }
  if (campo !== '' || linha.length) { fecharCampo(); linhas.push(linha); }
  return linhas;
}
