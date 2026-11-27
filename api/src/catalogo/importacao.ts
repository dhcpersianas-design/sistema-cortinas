import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { d, MARKUP_PADRAO_PCT, PRODUTOS_SEED, precoVendaSugerido } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import { historicoPrecosProduto, precosBarraTrilho, produtos } from '../db/schema.js';
import { parametro } from './parametros.js';
import { carregarCategorias, markupDe } from './categorias.js';
import {
  decodificarTexto, ErroPlanilha, escreverXlsx, lerCsv, lerXlsx, type Celula,
} from '../planilhas/xlsx.js';

/**
 * Importação da tabela de preços por planilha (Excel .xlsx ou CSV), só ADMIN.
 *
 * - Aba "Produtos": SKU, Nome, Categoria, Unidade, Cor/Coleção, Custo, Venda.
 *   SKU que já existe = atualiza só as colunas preenchidas; SKU novo = cria.
 * - Aba "Barras de trilho": SKU, Tamanho (m), Custo, Venda (tabela por barra, 1 a 6 m).
 * - Nada é apagado: célula vazia mantém o valor atual; produto não listado fica como está.
 * - Venda vazia em produto novo, em barra, ou em produto existente cujo custo mudou =
 *   sugestão pelo markup DA CATEGORIA do produto (Gabriel, 27/11/2026). Custo igual e venda vazia = mantém a venda.
 * - Categoria: aceita o caminho ("Persianas > Rolo > Double Vision"), só a subcategoria
 *   ("Double Vision") ou o id. Produto novo precisa de categoria final (sem subcategorias).
 * - Primeiro gera a prévia (nada gravado); depois aplica. Toda importação aplicada
 *   guarda o "antes e depois" para poder ser desfeita.
 */

type Tx = Parameters<Parameters<Banco['transaction']>[0]>[0];
type Exec = Banco | Tx;

export const LIMITE_LINHAS = 5000;
const UNIDADES = ['M2', 'ML', 'UN', 'PC'] as const;
type Unidade = typeof UNIDADES[number];
const RE_SKU = /^[A-Z0-9][A-Z0-9._-]{1,29}$/;

/** Códigos fixos que o cálculo usa sozinho (serviços, acessórios, confecção). Tecidos e persianas são escolhidos pelo vendedor. */
const PREFIXO_CATEGORIA: Record<string, number> = { TRI: 2, DES: 3, FIX: 4, MDO: 5, ACP: 31, MOT: 8, SRV: 9 };
export const SKUS_FIXOS = PRODUTOS_SEED.filter((p) => PREFIXO_CATEGORIA[p.sku.slice(0, 3)] !== undefined);

// ------------------------------------------------------------------ leitura do arquivo

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\(r\$\)|r\$|\(m\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

type Campo = 'sku' | 'nome' | 'categoria' | 'unidade' | 'cor' | 'custo' | 'venda' | 'tamanho';

function campoDoCabecalho(t: string): Campo | null {
  const n = norm(t);
  if (!n) return null;
  if (n.includes('sku') || n === 'codigo' || n === 'cod' || n === 'codigo do produto') return 'sku';
  if (n.includes('tamanho') || n.startsWith('barra') || n === 'metros') return 'tamanho';
  if (n.includes('custo')) return 'custo';
  if (n.includes('venda') || n === 'preco') return 'venda';
  if (n.startsWith('categoria')) return 'categoria';
  if (n.startsWith('unidade') || n === 'un' || n === 'unid') return 'unidade';
  if (n.startsWith('cor') || n.includes('colecao')) return 'cor';
  if (n.startsWith('nome') || n.startsWith('produto') || n.startsWith('descricao')) return 'nome';
  return null;
}

export type LinhaLida = { aba: string; linha: number } & Partial<Record<Campo, Celula>>;
export type Lido = { produtos: LinhaLida[]; barras: LinhaLida[] };

const vazia = (c?: Celula) => !c || c.texto.trim() === '';

/** Acha a linha de cabeçalho (com a coluna SKU) nas 10 primeiras linhas e lê a tabela abaixo dela. */
function lerTabela(aba: string, linhas: Celula[][], destino: Lido) {
  for (let i = 0; i < Math.min(10, linhas.length); i++) {
    const mapa = new Map<number, Campo>();
    (linhas[i] ?? []).forEach((c, j) => {
      const f = c.texto.length <= 40 ? campoDoCabecalho(c.texto) : null;
      if (f && ![...mapa.values()].includes(f)) mapa.set(j, f);
    });
    // Cabeçalho = SKU + pelo menos um preço (evita confundir com um texto de instruções).
    const campos = [...mapa.values()];
    if (!campos.includes('sku') || !(campos.includes('custo') || campos.includes('venda'))) continue;
    const ehBarra = [...mapa.values()].includes('tamanho');
    for (let k = i + 1; k < linhas.length; k++) {
      const l = linhas[k] ?? [];
      const item: LinhaLida = { aba, linha: k + 1 };
      for (const [j, f] of mapa) if (!vazia(l[j])) item[f] = { texto: l[j]!.texto.trim(), numero: l[j]!.numero };
      if ([...mapa.values()].every((f) => vazia(item[f]))) continue; // linha em branco
      (ehBarra ? destino.barras : destino.produtos).push(item);
    }
    return true;
  }
  return false;
}

export function lerArquivo(nome: string, buf: Buffer): Lido {
  const lido: Lido = { produtos: [], barras: [] };
  let achou = false;
  if (/\.xlsx$/i.test(nome)) {
    for (const aba of lerXlsx(buf)) achou = lerTabela(aba.nome, aba.linhas, lido) || achou;
  } else if (/\.(csv|txt)$/i.test(nome)) {
    achou = lerTabela('CSV', lerCsv(decodificarTexto(buf)), lido);
  } else if (/\.xls$/i.test(nome)) {
    throw new ErroPlanilha('Arquivo .xls (Excel antigo) não é aceito. No Excel, use "Salvar como" > "Pasta de Trabalho do Excel (.xlsx)".');
  } else {
    throw new ErroPlanilha('Envie uma planilha .xlsx (Excel) ou .csv.');
  }
  if (!achou) throw new ErroPlanilha('Não achei a coluna "SKU" na planilha. Use o modelo baixado no sistema (a primeira linha precisa ter os títulos das colunas).');
  if (lido.produtos.length + lido.barras.length === 0) throw new ErroPlanilha('A planilha não tem nenhuma linha preenchida.');
  if (lido.produtos.length + lido.barras.length > LIMITE_LINHAS) throw new ErroPlanilha(`A planilha tem mais de ${LIMITE_LINHAS} linhas. Divida em arquivos menores.`);
  return lido;
}

// ------------------------------------------------------------------ valores

/** Lê um valor em reais. Aceita 1.150,00 / 1150,00 / R$ 1.150,00 / 1150.5 (e número do Excel). */
export function lerValor(c: Celula): { valor: string } | { erro: string } {
  const bruto = c.texto.trim();
  if (c.numero) {
    if (!/^\d{1,8}(\.\d+)?$/.test(bruto)) return { erro: `valor inválido "${bruto}"` };
    const v = d(bruto);
    if (v.decimalPlaces() > 4) return { erro: `"${bruto}" tem mais de 4 casas decimais` };
    return { valor: v.toFixed(4) };
  }
  let t = bruto.replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (t.startsWith('-')) return { erro: 'valor negativo não é permitido' };
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) return { erro: `valor "${bruto}" ambíguo: escreva com vírgula nos centavos (ex.: 1150,00 ou 1,15)` };
  if (!/^\d{1,8}(\.\d{1,4})?$/.test(t)) return { erro: `valor "${bruto}" inválido (use números, ex.: 1150,00, até 4 casas decimais)` };
  return { valor: d(t).toFixed(4) };
}

function lerUnidade(t: string): Unidade | null {
  const n = norm(t.replace(/²/g, '2'));
  if (['m2', 'm 2', 'metro quadrado', 'metros quadrados'].includes(n)) return 'M2';
  if (['ml', 'm', 'metro', 'metro linear', 'metros lineares', 'metros'].includes(n)) return 'ML';
  if (['un', 'und', 'unid', 'unidade', 'unidades'].includes(n)) return 'UN';
  if (['pc', 'pca', 'peca', 'pecas', 'pç'].includes(n)) return 'PC';
  return null;
}

function lerTamanho(c: Celula): number | null {
  const t = c.texto.trim().toLowerCase().replace(/\s*(m|metros?)$/, '').replace(',', '.');
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

/** "R$ 1.150,00" (até 4 casas, mínimo 2). */
export function brl(v: string | null | undefined): string {
  if (v == null) return '—';
  const [i, dec = ''] = d(v).toFixed(4).split('.');
  const casas = dec.replace(/0+$/, '').padEnd(2, '0');
  return `R$ ${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${casas}`;
}

// ------------------------------------------------------------------ análise (prévia)

export type AcaoPrevia = 'CRIAR' | 'ATUALIZAR' | 'SEM_MUDANCA' | 'IGNORADA' | 'ERRO';
export type ItemPrevia = {
  aba: string; linha: number; tipo: 'PRODUTO' | 'BARRA'; sku: string; nome: string | null; tamanhoM: number | null;
  acao: AcaoPrevia; mudancas: string[]; erros: string[]; avisos: string[];
};
export type ResumoPrevia = { criar: number; atualizar: number; semMudanca: number; ignoradas: number; erros: number };
export type Previa = { arquivo: string; itens: ItemPrevia[]; resumo: ResumoPrevia; markupPct: string; markupPorCategoria: boolean };

type DadosProduto = { nome: string; categoriaId: number; unidadeMedida: Unidade; corColecao: string | null; custoUnitario: string; precoVendaUnitario: string };
type Operacao =
  | { tipo: 'CRIAR_PRODUTO'; sku: string; dados: DadosProduto; metadata: Record<string, unknown> }
  | { tipo: 'ATUALIZAR_PRODUTO'; produtoId: string; antes: Partial<DadosProduto>; depois: Partial<DadosProduto> }
  | { tipo: 'BARRA'; sku: string; produtoId: string | null; tamanhoM: number; antes: { custo: string; venda: string } | null; depois: { custo: string; venda: string } };

type ProdutoAtual = typeof produtos.$inferSelect;

const ROTULO: Record<keyof DadosProduto, string> = {
  nome: 'Nome', categoriaId: 'Categoria', unidadeMedida: 'Unidade', corColecao: 'Cor/Coleção', custoUnitario: 'Custo', precoVendaUnitario: 'Venda',
};

export async function analisar(db: Exec, lojaId: string, arquivo: string, lido: Lido, travar = false): Promise<{ previa: Previa; operacoes: Operacao[] }> {
  const markupPct = (await parametro(db as Banco, lojaId, 'MARKUP_PADRAO_PCT')) ?? MARKUP_PADRAO_PCT;
  const categorias = await carregarCategorias(db, lojaId);
  const nomeCategoria = new Map(categorias.map((c) => [c.id, c.caminho]));
  const ehTrilho = (id: number) => categorias.find((c) => c.id === id)?.trilho ?? false;
  const markupCat = (id: number) => markupDe(categorias, id, markupPct);
  const ehFinal = (id: number) => categorias.some((c) => c.id === id && !c.temSubcategorias);
  const acharCategoria = (t: string) => {
    const n = norm(t);
    if (/^\d+$/.test(n)) return categorias.find((c) => c.id === Number(n));
    // Caminho completo ou o fim do caminho; empate: a categoria final ganha ("Rolo" = Persianas › Rolo › Rolo).
    const iguais = categorias.filter((c) => norm(c.caminho) === n || norm(c.nome) === n || norm(c.caminho).endsWith(` ${n}`));
    const melhor = (l: typeof categorias) => l.find((c) => norm(c.caminho) === n) ?? l.find((c) => !c.temSubcategorias) ?? l[0];
    if (iguais.length) return melhor(iguais);
    return melhor(categorias.filter((c) => norm(c.nome).startsWith(n) || n.startsWith(norm(c.nome))))
      ?? categorias.find((c) => norm(c.nome).split(' ')[0] === n.split(' ')[0]);
  };

  const skuDe = (c?: Celula) => (c?.texto ?? '').trim().toUpperCase();
  const skus = [...new Set([...lido.produtos, ...lido.barras].map((l) => skuDe(l.sku)).filter(Boolean))];
  const consulta = db.select().from(produtos).where(inArray(produtos.sku, skus.length ? skus : ['']));
  const atuais = new Map((travar ? await consulta.for('update') : await consulta).map((p) => [p.sku, p]));
  const barrasAtuais = new Map<string, { custo: string; venda: string }>();
  const ids = [...atuais.values()].map((p) => p.id);
  if (ids.length) {
    for (const b of await db.select().from(precosBarraTrilho).where(inArray(precosBarraTrilho.produtoId, ids))) {
      barrasAtuais.set(`${b.produtoId}:${b.tamanhoM}`, { custo: b.custo, venda: b.venda });
    }
  }

  const itens: ItemPrevia[] = [];
  const operacoes: Operacao[] = [];
  /** SKU → categoria final (já considerando a planilha), para validar as barras. */
  const categoriaFinal = new Map<string, number>();
  const criados = new Set<string>();
  const vistos = new Map<string, number>();

  for (const l of lido.produtos) {
    const sku = skuDe(l.sku);
    const it: ItemPrevia = { aba: l.aba, linha: l.linha, tipo: 'PRODUTO', sku, nome: l.nome?.texto ?? null, tamanhoM: null, acao: 'ERRO', mudancas: [], erros: [], avisos: [] };
    itens.push(it);
    if (!sku) { it.erros.push('SKU vazio.'); continue; }
    if (!RE_SKU.test(sku)) { it.erros.push('SKU inválido: use letras, números, ponto ou hífen (2 a 30 caracteres).'); continue; }
    if (vistos.has(sku)) { it.erros.push(`SKU repetido na planilha (já aparece na linha ${vistos.get(sku)}).`); continue; }
    vistos.set(sku, l.linha);

    const novo: Partial<DadosProduto> = {};
    if (l.nome) {
      if (l.nome.texto.length > 160) it.erros.push('Nome com mais de 160 caracteres.');
      else novo.nome = l.nome.texto;
    }
    if (l.categoria) {
      const c = acharCategoria(l.categoria.texto);
      if (!c) it.erros.push(`Categoria "${l.categoria.texto}" não existe. Use uma destas: ${categorias.filter((x) => !x.temSubcategorias).map((x) => x.caminho).join(', ')}.`);
      else novo.categoriaId = c.id;
    }
    if (l.unidade) {
      const u = lerUnidade(l.unidade.texto);
      if (!u) it.erros.push(`Unidade "${l.unidade.texto}" inválida. Use M2, ML, UN ou PC.`);
      else novo.unidadeMedida = u;
    }
    if (l.cor) {
      if (l.cor.texto.length > 80) it.erros.push('Cor/Coleção com mais de 80 caracteres.');
      else novo.corColecao = l.cor.texto;
    }
    for (const [campo, chave] of [['custo', 'custoUnitario'], ['venda', 'precoVendaUnitario']] as const) {
      const c = l[campo];
      if (!c) continue;
      const v = lerValor(c);
      if ('erro' in v) it.erros.push(`${ROTULO[chave]}: ${v.erro}.`);
      else novo[chave] = v.valor;
    }
    if (it.erros.length) continue;

    const atual = atuais.get(sku);
    if (!atual) {
      const fixo = SKUS_FIXOS.find((p) => p.sku === sku);
      if (novo.custoUnitario === undefined && novo.precoVendaUnitario === undefined) {
        it.acao = 'IGNORADA';
        it.avisos.push('Produto novo sem preço: linha ignorada (preencha o Custo para cadastrar).');
        continue;
      }
      const dados = {
        nome: novo.nome ?? fixo?.nome,
        categoriaId: novo.categoriaId ?? (fixo ? PREFIXO_CATEGORIA[sku.slice(0, 3)] : undefined),
        unidadeMedida: novo.unidadeMedida ?? (fixo?.unidade as Unidade | undefined),
        corColecao: novo.corColecao ?? null,
        custoUnitario: novo.custoUnitario,
        precoVendaUnitario: novo.precoVendaUnitario,
      };
      if (!dados.nome) it.erros.push('Produto novo: preencha o Nome.');
      if (!dados.categoriaId || !nomeCategoria.has(dados.categoriaId)) it.erros.push('Produto novo: preencha a Categoria.');
      else if (!ehFinal(dados.categoriaId)) it.erros.push(`Produto novo: escolha a subcategoria de ${nomeCategoria.get(dados.categoriaId)} (ex.: ${categorias.filter((c) => c.paiId === dados.categoriaId).map((c) => c.nome).slice(0, 3).join(', ')}).`);
      if (!dados.unidadeMedida) it.erros.push('Produto novo: preencha a Unidade (M2, ML, UN ou PC).');
      if (!dados.custoUnitario) it.erros.push('Produto novo: preencha o Custo.');
      if (it.erros.length) continue;
      if (!dados.precoVendaUnitario) {
        const m = markupCat(dados.categoriaId!);
        dados.precoVendaUnitario = precoVendaSugerido(dados.custoUnitario!, m).toFixed(4);
        it.avisos.push(`Venda vazia: calculada pelo markup da categoria, ${Number(m)}% (${brl(dados.precoVendaUnitario)}).`);
      }
      it.nome = dados.nome!;
      it.acao = 'CRIAR';
      it.mudancas.push(`Novo produto em ${nomeCategoria.get(dados.categoriaId!)} (${dados.unidadeMedida}): custo ${brl(dados.custoUnitario)}, venda ${brl(dados.precoVendaUnitario)}`);
      if (!fixo && ['PERSIANA', 'TECIDO', 'MOTORIZACAO'].includes(categorias.find((c) => c.id === dados.categoriaId)?.perfil ?? '')) {
        it.avisos.push('Depois confira os dados técnicos na tela do produto (ex.: largura do rolo, medidas máximas, canais).');
      }
      operacoes.push({ tipo: 'CRIAR_PRODUTO', sku, dados: dados as DadosProduto, metadata: fixo?.metadata ?? {} });
      categoriaFinal.set(sku, dados.categoriaId!);
      criados.add(sku);
      continue;
    }

    it.nome = novo.nome ?? atual.nome;
    categoriaFinal.set(sku, novo.categoriaId ?? atual.categoriaId);
    const antes: Partial<DadosProduto> = {};
    const depois: Partial<DadosProduto> = {};
    const valorAtual: DadosProduto = {
      nome: atual.nome, categoriaId: atual.categoriaId, unidadeMedida: atual.unidadeMedida as Unidade, corColecao: atual.corColecao,
      custoUnitario: atual.custoUnitario, precoVendaUnitario: atual.precoVendaUnitario,
    };
    for (const k of Object.keys(novo) as (keyof DadosProduto)[]) {
      const a = valorAtual[k];
      const n = novo[k]!;
      const igual = k === 'custoUnitario' || k === 'precoVendaUnitario' ? d(String(a)).eq(d(String(n))) : a === n;
      if (igual) continue;
      (antes as Record<string, unknown>)[k] = a;
      (depois as Record<string, unknown>)[k] = n;
      const fmt = (v: unknown) => (k === 'custoUnitario' || k === 'precoVendaUnitario' ? brl(v as string)
        : k === 'categoriaId' ? nomeCategoria.get(v as number) ?? String(v) : v == null || v === '' ? '(vazio)' : String(v));
      it.mudancas.push(`${ROTULO[k]}: ${fmt(a)} → ${fmt(n)}`);
    }
    if (depois.categoriaId !== undefined && !ehFinal(depois.categoriaId)) {
      it.erros.push(`Escolha a subcategoria de ${nomeCategoria.get(depois.categoriaId)}.`);
      continue;
    }
    // Custo mudou e a coluna Venda veio vazia: recalcula a venda pelo markup da categoria (decisões do Gabriel, 27/11/2026).
    if (depois.custoUnitario && !l.venda) {
      const m = markupCat(depois.categoriaId ?? atual.categoriaId);
      const sugerida = precoVendaSugerido(depois.custoUnitario, m).toFixed(4);
      if (!d(sugerida).eq(d(atual.precoVendaUnitario))) {
        antes.precoVendaUnitario = atual.precoVendaUnitario;
        depois.precoVendaUnitario = sugerida;
        it.mudancas.push(`Venda: ${brl(atual.precoVendaUnitario)} → ${brl(sugerida)}`);
      }
      it.avisos.push(`Custo mudou e a coluna Venda está vazia: venda recalculada pelo markup da categoria, ${Number(m)}% (${brl(sugerida)}).`);
    }
    if (!it.mudancas.length) { it.acao = 'SEM_MUDANCA'; continue; }
    it.acao = 'ATUALIZAR';
    if (depois.unidadeMedida) it.avisos.push('Mudar a unidade muda o jeito de calcular este produto nos próximos orçamentos.');
    if (atual.ativo === false) it.avisos.push('Este produto está inativo: os preços mudam, mas ele continua inativo.');
    operacoes.push({ tipo: 'ATUALIZAR_PRODUTO', produtoId: atual.id, antes, depois });
  }

  const vistasBarras = new Map<string, number>();
  const tamanhosFinais = new Map<string, Set<number>>();
  for (const [k] of barrasAtuais) {
    const [pid, t] = k.split(':');
    const sku = [...atuais.values()].find((p) => p.id === pid)!.sku;
    tamanhosFinais.set(sku, new Set([...(tamanhosFinais.get(sku) ?? []), Number(t)]));
  }
  const ultimoItemBarra = new Map<string, ItemPrevia>();
  for (const l of lido.barras) {
    const sku = skuDe(l.sku);
    const it: ItemPrevia = { aba: l.aba, linha: l.linha, tipo: 'BARRA', sku, nome: null, tamanhoM: null, acao: 'ERRO', mudancas: [], erros: [], avisos: [] };
    itens.push(it);
    if (!sku) { it.erros.push('SKU vazio.'); continue; }
    const atual = atuais.get(sku);
    it.nome = atual?.nome ?? null;
    const tamanho = l.tamanho ? lerTamanho(l.tamanho) : null;
    if (tamanho === null) { it.erros.push(`Tamanho da barra "${l.tamanho?.texto ?? ''}" inválido: use um número inteiro de 1 a 6 (metros).`); continue; }
    it.tamanhoM = tamanho;
    if (!l.custo && !l.venda) { it.acao = 'IGNORADA'; it.avisos.push('Barra sem preço: linha ignorada.'); continue; }
    if (!atual && !criados.has(sku)) {
      it.erros.push(vistos.has(sku) ? 'O produto deste SKU tem erro na aba Produtos; corrija lá primeiro.' : 'SKU não existe no catálogo. Cadastre o trilho (aba Produtos) antes.');
      continue;
    }
    const cat = categoriaFinal.get(sku) ?? atual!.categoriaId;
    if (!ehTrilho(cat)) { it.erros.push('Preço por barra só vale para produtos da categoria Trilhos e Varões.'); continue; }
    const chave = `${sku}:${tamanho}`;
    if (vistasBarras.has(chave)) { it.erros.push(`Barra de ${tamanho} m repetida (já aparece na linha ${vistasBarras.get(chave)}).`); continue; }
    vistasBarras.set(chave, l.linha);
    if (!l.custo) { it.erros.push('Preencha o Custo da barra.'); continue; }
    const custo = lerValor(l.custo);
    if ('erro' in custo) { it.erros.push(`Custo: ${custo.erro}.`); continue; }
    let venda: string;
    if (l.venda) {
      const v = lerValor(l.venda);
      if ('erro' in v) { it.erros.push(`Venda: ${v.erro}.`); continue; }
      venda = v.valor;
    } else {
      const m = markupCat(cat);
      venda = precoVendaSugerido(custo.valor, m).toFixed(4);
      it.avisos.push(`Venda vazia: calculada pelo markup da categoria, ${Number(m)}% (${brl(venda)}).`);
    }
    const antes = atual ? barrasAtuais.get(`${atual.id}:${tamanho}`) ?? null : null;
    if (antes && d(antes.custo).eq(d(custo.valor)) && d(antes.venda).eq(d(venda))) { it.acao = 'SEM_MUDANCA'; continue; }
    it.acao = antes ? 'ATUALIZAR' : 'CRIAR';
    it.mudancas.push(antes
      ? `Barra ${tamanho} m: custo ${brl(antes.custo)} → ${brl(custo.valor)}, venda ${brl(antes.venda)} → ${brl(venda)}`
      : `Barra ${tamanho} m: custo ${brl(custo.valor)}, venda ${brl(venda)}`);
    operacoes.push({ tipo: 'BARRA', sku, produtoId: atual?.id ?? null, tamanhoM: tamanho, antes, depois: { custo: custo.valor, venda } });
    tamanhosFinais.set(sku, new Set([...(tamanhosFinais.get(sku) ?? []), tamanho]));
    ultimoItemBarra.set(sku, it);
  }
  for (const [sku, it] of ultimoItemBarra) {
    const n = tamanhosFinais.get(sku)?.size ?? 0;
    if (n < 6) it.avisos.push(`A tabela de barras deste trilho fica com ${n} de 6 tamanhos. Até completar os 6, o cálculo cobra por metro.`);
  }

  for (const it of itens) if (it.erros.length) it.acao = 'ERRO';
  const resumo: ResumoPrevia = { criar: 0, atualizar: 0, semMudanca: 0, ignoradas: 0, erros: 0 };
  for (const it of itens) {
    if (it.acao === 'CRIAR') resumo.criar++;
    else if (it.acao === 'ATUALIZAR') resumo.atualizar++;
    else if (it.acao === 'SEM_MUDANCA') resumo.semMudanca++;
    else if (it.acao === 'IGNORADA') resumo.ignoradas++;
    else resumo.erros++;
  }
  return { previa: { arquivo, itens, resumo, markupPct, markupPorCategoria: true }, operacoes };
}

// ------------------------------------------------------------------ aplicar

export async function aplicar(db: Banco, lojaId: string, usuarioId: string, arquivo: string, lido: Lido) {
  return db.transaction(async (tx) => {
    // Uma importação por vez.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(727010)`);
    const { previa, operacoes } = await analisar(tx, lojaId, arquivo, lido, true);
    if (!operacoes.length) return { previa, importacaoId: null as string | null };
    const motivo = `Importação de planilha: ${arquivo}`.slice(0, 200);
    const [imp] = (await tx.execute(sql`
      INSERT INTO importacoes_preco (loja_id, nome_arquivo, criado_por, resumo)
      VALUES (${lojaId}, ${arquivo.slice(0, 200)}, ${usuarioId}, ${JSON.stringify(previa.resumo)}::jsonb) RETURNING id`)).rows as { id: string }[];
    const importacaoId = imp!.id;
    const item = (produtoId: string, tamanhoM: number | null, acao: string, antes: unknown, depois: unknown) => tx.execute(sql`
      INSERT INTO importacoes_preco_itens (importacao_id, produto_id, tamanho_m, acao, antes, depois)
      VALUES (${importacaoId}, ${produtoId}, ${tamanhoM}, ${acao}, ${antes === null ? null : JSON.stringify(antes)}::jsonb, ${JSON.stringify(depois)}::jsonb)`);
    const idPorSku = new Map<string, string>();

    for (const op of operacoes) {
      if (op.tipo === 'CRIAR_PRODUTO') {
        const [p] = await tx.insert(produtos).values({ sku: op.sku, ...op.dados, metadataTecnica: op.metadata }).returning({ id: produtos.id });
        idPorSku.set(op.sku, p!.id);
        await tx.insert(historicoPrecosProduto).values({
          produtoId: p!.id, custoNovo: op.dados.custoUnitario, vendaNova: op.dados.precoVendaUnitario, alteradoPor: usuarioId, motivo, importacaoId,
        });
        await item(p!.id, null, 'CRIOU_PRODUTO', null, op.dados);
      } else if (op.tipo === 'ATUALIZAR_PRODUTO') {
        const [atual] = await tx.select().from(produtos).where(eq(produtos.id, op.produtoId));
        await tx.update(produtos).set({ ...op.depois, atualizadoEm: sql`NOW()` }).where(eq(produtos.id, op.produtoId));
        if (op.depois.custoUnitario !== undefined || op.depois.precoVendaUnitario !== undefined) {
          await tx.insert(historicoPrecosProduto).values({
            produtoId: op.produtoId, custoAnterior: atual!.custoUnitario, custoNovo: op.depois.custoUnitario ?? atual!.custoUnitario,
            vendaAnterior: atual!.precoVendaUnitario, vendaNova: op.depois.precoVendaUnitario ?? atual!.precoVendaUnitario,
            alteradoPor: usuarioId, motivo, importacaoId,
          });
        }
        await item(op.produtoId, null, 'ATUALIZOU_PRODUTO', op.antes, op.depois);
      } else {
        const produtoId = op.produtoId ?? idPorSku.get(op.sku)!;
        await tx.insert(precosBarraTrilho).values({ produtoId, tamanhoM: op.tamanhoM, ...op.depois })
          .onConflictDoUpdate({ target: [precosBarraTrilho.produtoId, precosBarraTrilho.tamanhoM], set: { ...op.depois, atualizadoEm: sql`NOW()` } });
        await tx.insert(historicoPrecosProduto).values({
          produtoId, tamanhoM: op.tamanhoM, custoAnterior: op.antes?.custo ?? null, custoNovo: op.depois.custo,
          vendaAnterior: op.antes?.venda ?? null, vendaNova: op.depois.venda, alteradoPor: usuarioId, motivo, importacaoId,
        });
        await item(produtoId, op.tamanhoM, op.antes ? 'ATUALIZOU_BARRA' : 'CRIOU_BARRA', op.antes, op.depois);
      }
    }
    return { previa, importacaoId };
  });
}

// ------------------------------------------------------------------ histórico e desfazer

export async function listarImportacoes(db: Banco, lojaId: string) {
  return (await db.execute(sql`
    SELECT i.id, i.nome_arquivo AS "arquivo", i.criado_em AS "criadoEm", u.nome AS "criadoPor", i.resumo,
           i.desfeita_em AS "desfeitaEm", ud.nome AS "desfeitaPor",
           (SELECT COUNT(*)::int FROM importacoes_preco_itens x WHERE x.importacao_id = i.id) AS "alteracoes"
    FROM importacoes_preco i
    LEFT JOIN usuarios u ON u.id = i.criado_por
    LEFT JOIN usuarios ud ON ud.id = i.desfeita_por
    WHERE i.loja_id = ${lojaId}
    ORDER BY i.criado_em DESC LIMIT 50`)).rows;
}

type ItemImportado = { id: string; produto_id: string; tamanho_m: number | null; acao: string; antes: Record<string, unknown> | null; depois: Record<string, unknown>; sku: string };

const mesmoValor = (a: unknown, b: unknown) => {
  if (a == null || b == null) return a == b;
  if (typeof a === 'string' && typeof b === 'string' && /^\d+(\.\d+)?$/.test(a) && /^\d+(\.\d+)?$/.test(b)) return d(a).eq(d(b));
  return a === b;
};

/**
 * Volta cada produto/barra ao valor de antes da importação. Se alguém mudou o
 * item depois da importação, ele é mantido (não sobrescreve trabalho novo) e
 * aparece na lista de "mantidos". Produto criado pela importação é inativado,
 * não apagado (pode já estar em algum orçamento).
 */
export async function desfazer(db: Banco, lojaId: string, usuarioId: string, importacaoId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(727010)`);
    const [imp] = (await tx.execute(sql`SELECT id, nome_arquivo, desfeita_em FROM importacoes_preco WHERE id = ${importacaoId} AND loja_id = ${lojaId} FOR UPDATE`)).rows as
      { id: string; nome_arquivo: string; desfeita_em: string | null }[];
    if (!imp) return { erro: 'Importação não encontrada.', status: 404 } as const;
    if (imp.desfeita_em) return { erro: 'Esta importação já foi desfeita.', status: 409 } as const;
    const itens = (await tx.execute(sql`
      SELECT x.id, x.produto_id, x.tamanho_m, x.acao, x.antes, x.depois, p.sku
      FROM importacoes_preco_itens x JOIN produtos p ON p.id = x.produto_id
      WHERE x.importacao_id = ${importacaoId} ORDER BY x.id DESC`)).rows as ItemImportado[];
    const motivo = `Desfeita a importação: ${imp.nome_arquivo}`.slice(0, 200);
    const mantidos: string[] = [];
    let restaurados = 0;

    for (const it of itens) {
      if (it.acao === 'CRIOU_BARRA' || it.acao === 'ATUALIZOU_BARRA') {
        const [b] = await tx.select().from(precosBarraTrilho)
          .where(and(eq(precosBarraTrilho.produtoId, it.produto_id), eq(precosBarraTrilho.tamanhoM, it.tamanho_m!))).for('update');
        if (!b || !mesmoValor(b.custo, it.depois.custo) || !mesmoValor(b.venda, it.depois.venda)) {
          mantidos.push(`${it.sku} barra ${it.tamanho_m} m (alterada depois da importação)`); continue;
        }
        if (it.acao === 'CRIOU_BARRA') {
          await tx.delete(precosBarraTrilho).where(and(eq(precosBarraTrilho.produtoId, it.produto_id), eq(precosBarraTrilho.tamanhoM, it.tamanho_m!)));
        } else {
          await tx.update(precosBarraTrilho).set({ custo: String(it.antes!.custo), venda: String(it.antes!.venda), atualizadoEm: sql`NOW()` })
            .where(and(eq(precosBarraTrilho.produtoId, it.produto_id), eq(precosBarraTrilho.tamanhoM, it.tamanho_m!)));
        }
        await tx.insert(historicoPrecosProduto).values({
          produtoId: it.produto_id, tamanhoM: it.tamanho_m, custoAnterior: b.custo, vendaAnterior: b.venda,
          custoNovo: (it.antes?.custo as string | undefined) ?? null, vendaNova: (it.antes?.venda as string | undefined) ?? null,
          alteradoPor: usuarioId, motivo, importacaoId,
        });
        restaurados++;
        continue;
      }
      const [p] = await tx.select().from(produtos).where(eq(produtos.id, it.produto_id)).for('update');
      const atual = p as unknown as Record<string, unknown>;
      if (!p || !Object.entries(it.depois).every(([k, v]) => mesmoValor(atual[k], v))) {
        mantidos.push(`${it.sku} (alterado depois da importação)`); continue;
      }
      if (it.acao === 'CRIOU_PRODUTO') {
        await tx.update(produtos).set({ ativo: false, atualizadoEm: sql`NOW()` }).where(eq(produtos.id, p.id));
      } else {
        await tx.update(produtos).set({ ...(it.antes as Partial<DadosProduto>), atualizadoEm: sql`NOW()` }).where(eq(produtos.id, p.id));
        if ('custoUnitario' in it.depois || 'precoVendaUnitario' in it.depois) {
          await tx.insert(historicoPrecosProduto).values({
            produtoId: p.id, custoAnterior: p.custoUnitario, vendaAnterior: p.precoVendaUnitario,
            custoNovo: (it.antes!.custoUnitario as string | undefined) ?? p.custoUnitario,
            vendaNova: (it.antes!.precoVendaUnitario as string | undefined) ?? p.precoVendaUnitario,
            alteradoPor: usuarioId, motivo, importacaoId,
          });
        }
      }
      restaurados++;
    }
    await tx.execute(sql`UPDATE importacoes_preco SET desfeita_em = NOW(), desfeita_por = ${usuarioId} WHERE id = ${importacaoId}`);
    return { restaurados, mantidos } as const;
  });
}

// ------------------------------------------------------------------ planilha para baixar

const num = (v: string | null | undefined) => (v == null ? null : Number(d(v).toFixed(4)));

/**
 * Planilha com o catálogo atual (para editar os preços e importar de volta),
 * mais as linhas em branco dos códigos fixos que o cálculo usa e ainda não
 * existem (serviços SRV, acessórios, confecção), e a tabela de barras de cada trilho.
 */
export async function planilhaPrecos(db: Banco, lojaId: string): Promise<Buffer> {
  const categorias = await carregarCategorias(db, lojaId);
  const nomeCat = new Map(categorias.map((c) => [c.id, c.caminho.replace(/ › /g, ' > ')]));
  const lista = await db.select().from(produtos).where(eq(produtos.ativo, true));
  const ordem = new Map(categorias.map((c, i) => [c.id, i]));
  lista.sort((a, b) => (ordem.get(a.categoriaId)! - ordem.get(b.categoriaId)!) || a.sku.localeCompare(b.sku));
  const existentes = new Set((await db.select({ sku: produtos.sku }).from(produtos)).map((p) => p.sku));
  const faltando = SKUS_FIXOS.filter((p) => !existentes.has(p.sku));

  const linhasProdutos: (string | number | null)[][] = [['SKU', 'Nome', 'Categoria', 'Unidade', 'Cor/Coleção', 'Custo', 'Venda']];
  for (const p of lista) linhasProdutos.push([p.sku, p.nome, nomeCat.get(p.categoriaId) ?? '', p.unidadeMedida, p.corColecao, num(p.custoUnitario), num(p.precoVendaUnitario)]);
  for (const p of faltando) linhasProdutos.push([p.sku, p.nome, nomeCat.get(PREFIXO_CATEGORIA[p.sku.slice(0, 3)]!) ?? '', p.unidade, null, null, null]);

  const trilhos = lista.filter((p) => categorias.find((c) => c.id === p.categoriaId)?.trilho);
  const barras = trilhos.length
    ? await db.select().from(precosBarraTrilho).where(inArray(precosBarraTrilho.produtoId, trilhos.map((t) => t.id)))
    : [];
  const linhasBarras: (string | number | null)[][] = [['SKU', 'Trilho', 'Tamanho da barra (m)', 'Custo', 'Venda']];
  for (const t of trilhos) {
    for (let m = 1; m <= 6; m++) {
      const b = barras.find((x) => x.produtoId === t.id && x.tamanhoM === m);
      linhasBarras.push([t.sku, t.nome, m, num(b?.custo), num(b?.venda)]);
    }
  }

  const instrucoes: string[][] = [
    ['Como usar esta planilha'],
    [''],
    ['1. Na aba "Produtos", altere o Custo e a Venda (ou outras colunas) e acrescente linhas para produtos novos.'],
    ['2. Na aba "Barras de trilho", preencha o custo e a venda de cada tamanho de barra (1 a 6 metros) de cada trilho.'],
    ['3. Salve e envie em Catálogo > Importar preços. O sistema mostra uma prévia antes de gravar qualquer coisa.'],
    [''],
    ['Regras'],
    ['• O SKU identifica o produto. SKU que já existe é atualizado; SKU novo é cadastrado.'],
    ['• Célula vazia mantém o valor atual. A importação nunca apaga produtos.'],
    ['• Venda vazia: produto novo, barra e produto cujo custo mudou recebem a venda pelo markup da categoria (lista abaixo). Se o custo não mudou, a venda atual fica.'],
    ['• Categoria: escreva como na lista abaixo (ex.: "Persianas > Rolo > Double Vision") ou só o último nome ("Double Vision"). Persiana nova precisa da subcategoria.'],
    ['• Valores em reais, com vírgula nos centavos (ex.: 1150,00). Até 4 casas decimais.'],
    ['• Linha de produto novo sem custo é ignorada (as linhas de SRV, MOT, ACP etc. em branco são os códigos que o orçamento usa; preencha para ativar).'],
    ['• Para o trilho ser cobrado por barra, preencha os 6 tamanhos. Até lá, ele é cobrado por metro.'],
    ['• Tecidos, persianas e motores novos: depois confira os dados técnicos (largura do rolo, medidas máximas, canais) na tela do produto.'],
    ['• Também é aceito arquivo .csv (separado por ponto e vírgula) com as mesmas colunas.'],
    [''],
    ['Unidades'],
    ['M2 = metro quadrado · ML = metro linear · UN = unidade · PC = peça'],
    [''],
    ['Categorias (markup = venda sugerida sobre o custo)'],
    ...categorias.filter((c) => !c.temSubcategorias).map((c) => [`${nomeCat.get(c.id)}   (markup ${c.markupEfetivo}%)`]),
  ];

  return escreverXlsx([
    { nome: 'Produtos', linhas: linhasProdutos, larguras: [14, 40, 26, 10, 22, 14, 14] },
    { nome: 'Barras de trilho', linhas: linhasBarras, larguras: [14, 36, 20, 14, 14] },
    { nome: 'Instruções', linhas: instrucoes, larguras: [120], semCabecalho: true },
  ]);
}
