import { d, ErroEntrada } from './decimal.js';
import type { Produto } from './tipos.js';

export interface LinhaPrecoBarra {
  sku: string;
  tamanhoM: string;
  custo: string;
  venda: string;
}

export interface ResultadoPrecosBarra {
  /** Produtos com `precos_barra` aplicado aos SKUs com tabela completa. */
  produtos: Produto[];
  /** SKUs que passaram a cobrar por tamanho de barra. */
  skusComTabela: string[];
  /** Avisos de preenchimento (linhas incompletas, SKUs parciais). Não bloqueiam. */
  avisos: string[];
}

/**
 * Lê a planilha `dados/precos-barra-trilho.csv`.
 * Aceita `;` ou `,` como separador de coluna, vírgula ou ponto decimal,
 * "R$" e separador de milhar (1.150,00). Colunas: sku;nome;tamanho_m;custo;venda
 * (a coluna nome é só para leitura humana).
 */
export function lerPrecosBarraCSV(texto: string): { linhas: LinhaPrecoBarra[]; avisos: string[] } {
  const linhasTxt = texto.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (linhasTxt.length === 0) return { linhas: [], avisos: [] };
  const sep = linhasTxt[0]!.includes(';') ? ';' : ',';
  const cab = linhasTxt[0]!.split(sep).map((c) => c.trim().toLowerCase());
  const idx = (n: string) => {
    const i = cab.indexOf(n);
    if (i < 0) throw new ErroEntrada(`Planilha de preços por barra sem a coluna "${n}"`);
    return i;
  };
  const iSku = idx('sku'), iTam = idx('tamanho_m'), iCusto = idx('custo'), iVenda = idx('venda');

  const linhas: LinhaPrecoBarra[] = [];
  const avisos: string[] = [];
  linhasTxt.slice(1).forEach((l, n) => {
    const col = l.split(sep).map((c) => c.trim());
    const nLinha = n + 2;
    const sku = col[iSku] ?? '';
    const custo = col[iCusto] ?? '';
    const venda = col[iVenda] ?? '';
    if (!sku) return;
    if (!custo && !venda) return; // ainda não preenchida
    if (!custo || !venda) {
      avisos.push(`Linha ${nLinha} (${sku}, ${col[iTam]} m): preencha custo e venda; linha ignorada.`);
      return;
    }
    try {
      linhas.push({
        sku,
        tamanhoM: d(normalizarNumero(col[iTam] ?? '')).toString(),
        custo: d(normalizarNumero(custo)).toFixed(2),
        venda: d(normalizarNumero(venda)).toFixed(2),
      });
    } catch {
      avisos.push(`Linha ${nLinha} (${sku}): número inválido; linha ignorada.`);
    }
  });
  return { linhas, avisos };
}

/** "R$ 1.150,00" -> "1150.00"; "55,5" -> "55.5"; "55.50" -> "55.50". */
export function normalizarNumero(v: string): string {
  let s = v.replace(/R\$/i, '').replace(/\s/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return s;
}

/**
 * Aplica a tabela aos produtos. Só ativa o preço por barra num SKU quando TODOS os
 * tamanhos de 1 m até `barra_max` estiverem preenchidos; senão o SKU segue cobrado
 * por ML e um aviso diz quais tamanhos faltam.
 */
export function aplicarPrecosBarra(produtos: Produto[], linhas: LinhaPrecoBarra[]): ResultadoPrecosBarra {
  const avisos: string[] = [];
  const porSku = new Map<string, Record<string, { custo: string; venda: string }>>();
  for (const l of linhas) {
    const t = porSku.get(l.sku) ?? {};
    t[l.tamanhoM] = { custo: l.custo, venda: l.venda };
    porSku.set(l.sku, t);
  }
  const conhecidos = new Set(produtos.map((p) => p.sku));
  for (const sku of porSku.keys()) {
    if (!conhecidos.has(sku)) avisos.push(`SKU ${sku} da planilha não existe no catálogo; ignorado.`);
  }

  const skusComTabela: string[] = [];
  const out = produtos.map((p) => {
    const tabela = porSku.get(p.sku);
    if (!tabela) return p;
    const max = Number(p.metadata?.['barra_max'] ?? 6);
    const faltam = Array.from({ length: max }, (_, i) => String(i + 1)).filter((t) => !tabela[t]);
    if (faltam.length > 0) {
      avisos.push(`SKU ${p.sku}: faltam preços das barras de ${faltam.join(', ')} m; continua cobrado por ML.`);
      return p;
    }
    skusComTabela.push(p.sku);
    return { ...p, metadata: { ...p.metadata, precos_barra: tabela } };
  });
  return { produtos: out, skusComTabela, avisos };
}
