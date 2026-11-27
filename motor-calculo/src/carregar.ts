import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { criarCatalogo, PRODUTOS_SEED } from './catalogo-seed.js';
import { aplicarPrecosBarra, lerPrecosBarraCSV } from './precos-barra.js';
import type { Catalogo, Produto } from './tipos.js';

/** Caminho da planilha que acompanha o pacote: motor-calculo/dados/precos-barra-trilho.csv */
export const CAMINHO_PRECOS_BARRA = join(dirname(fileURLToPath(import.meta.url)), '..', 'dados', 'precos-barra-trilho.csv');

/**
 * Monta o catálogo a partir do seed + planilha de preços por barra (Node apenas).
 * Linhas vazias da planilha são ignoradas: o trilho segue cobrado por ML até que
 * todos os tamanhos daquele SKU estejam preenchidos.
 */
export function carregarCatalogo(opcoes: { produtos?: Produto[]; caminhoPrecosBarra?: string } = {}): {
  catalogo: Catalogo;
  skusComTabela: string[];
  avisos: string[];
} {
  const caminho = opcoes.caminhoPrecosBarra ?? CAMINHO_PRECOS_BARRA;
  const base = opcoes.produtos ?? PRODUTOS_SEED;
  if (!existsSync(caminho)) return { catalogo: criarCatalogo(base), skusComTabela: [], avisos: [`Planilha não encontrada: ${caminho}`] };
  const lido = lerPrecosBarraCSV(readFileSync(caminho, 'utf-8'));
  const r = aplicarPrecosBarra(base, lido.linhas);
  return { catalogo: criarCatalogo(r.produtos), skusComTabela: r.skusComTabela, avisos: [...lido.avisos, ...r.avisos] };
}
