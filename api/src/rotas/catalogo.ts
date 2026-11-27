import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { d, MARKUP_PADRAO_PCT, precoVendaSugerido, STATUS_DISPONIBILIDADE } from '@sistema/motor-calculo';
import {
  categoriasProduto, fornecedores, historicoPrecosProduto, precosBarraTrilho, produtos, usuarios,
} from '../db/schema.js';
import { exigir } from '../auth/plugin.js';
import { pode } from '../auth/permissoes.js';
import { parametro } from '../catalogo/parametros.js';
import { mensagemErro, termoLike, textoOpcional } from '../cadastros/campos.js';
import { aplicar, desfazer, lerArquivo, listarImportacoes, planilhaPrecos, analisar } from '../catalogo/importacao.js';
import { ErroPlanilha } from '../planilhas/xlsx.js';
import { carregarCategorias, erroCategoriaProduto, markupDe, type CategoriaArvore } from '../catalogo/categorias.js';
import { aplicarMarkup, erroMarkupCategoria, previaMarkup } from '../catalogo/markup-categoria.js';
import { faltaConfirmacao, respostaConfirmacao } from '../catalogo/confirmacao.js';

/**
 * Catálogo de componentes (especificação v1.1, seções 7 e 13).
 * - Todos veem o preço de venda; custo só com `custos.ver` (ADMIN ou vendedor liberado).
 * - Só o ADMIN cadastra produtos e preenche preços, inclusive a tabela de preço por
 *   tamanho de barra do trilho (1 a 6 m). Toda mudança de preço vai para
 *   `historico_precos_produto` (com `tamanho_m` quando é a tabela de barras).
 * - Preço de venda em branco = sugestão pelo markup DA CATEGORIA do produto (vazio = da categoria
 *   de cima; nenhuma = MARKUP_PADRAO_PCT, 100%: venda = 2x custo). Gabriel, 27/11/2026.
 * - Categorias em árvore (4 principais + Serviços, com subcategorias): produto novo só em
 *   categoria final (sem subcategorias). Ver catalogo/categorias.ts.
 */

const valor = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const t = String(v).trim().replace(/^R\$\s*/, '');
  // Aceita 1.150,00 / 1150,00 / 1150.00
  const n = /,\d{1,4}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^\d{1,8}(\.\d{1,4})?$/.test(n)) { ctx.addIssue({ code: 'custom', message: 'Valor inválido (use até 4 casas decimais)' }); return z.NEVER; }
  return d(n).toFixed(4);
});

const corpoProduto = z.object({
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{1,29}$/, 'SKU: letras, números, ponto, hífen (2 a 30)'),
  categoriaId: z.coerce.number().int().positive(),
  nome: z.string().trim().min(2, 'Informe o nome').max(160),
  corColecao: textoOpcional(80),
  unidadeMedida: z.enum(['M2', 'ML', 'UN', 'PC'], 'Unidade inválida'),
  custoUnitario: valor,
  precoVendaUnitario: valor.nullish(),
  fornecedorPadraoId: z.uuid().nullish().transform((v) => v ?? null),
  metadataTecnica: z.record(z.string(), z.unknown()).default({}),
  motivo: textoOpcional(200),
  /** Disponibilidade (Gabriel, 27/11/2026). Previsão obrigatória em "em falta com previsão". */
  disponibilidade: z.enum(STATUS_DISPONIBILIDADE, 'Status de disponibilidade inválido').default('DISPONIVEL'),
  previsaoDisponivel: z.iso.date('Previsão: data inválida').nullish().transform((v) => v ?? null),
});
// Sem `.default` aqui: no zod 4 o default vale até dentro de `.partial()` e apagaria o metadata.
const corpoEditarProduto = corpoProduto.omit({ motivo: true })
  .extend({ metadataTecnica: z.record(z.string(), z.unknown()), ativo: z.boolean(), disponibilidade: z.enum(STATUS_DISPONIBILIDADE, 'Status de disponibilidade inválido') }).partial()
  .extend({ motivo: textoOpcional(200) });

/** Erro se o status pede previsão e ela não veio (ou o contrário: limpa a previsão). */
function ajustarPrevisao<T extends { disponibilidade?: string; previsaoDisponivel?: string | null }>(dados: T): string | null {
  if (dados.disponibilidade === undefined) return null;
  if (dados.disponibilidade === 'EM_FALTA_COM_PREVISAO') return dados.previsaoDisponivel ? null : 'Em falta com previsão: informe a data da previsão.';
  dados.previsaoDisponivel = null;
  return null;
}

const corpoBarras = z.object({
  barras: z.array(z.object({
    tamanhoM: z.coerce.number().int().min(1).max(6),
    custo: valor.nullish(),
    venda: valor.nullish(),
  })).max(6),
  motivo: textoOpcional(200),
});

const filtros = z.object({
  q: z.string().trim().max(100).optional(),
  categoriaId: z.coerce.number().int().positive().optional(),
  inativos: z.enum(['0', '1']).optional(),
});

const corpoNovaCategoria = z.object({
  nome: z.string().trim().min(2, 'Informe o nome').max(80),
  paiId: z.coerce.number().int().positive(),
});
const markupCampo = z.union([z.string(), z.number()]).nullable().transform((v, ctx) => {
  if (v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace('%', '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 1000) { ctx.addIssue({ code: 'custom', message: 'Markup inválido (0 a 1000%)' }); return z.NEVER; }
  return n.toFixed(2);
});
const corpoEditarCategoria = z.object({
  nome: z.string().trim().min(2, 'Informe o nome').max(80).optional(),
  markupPct: markupCampo.optional(),
  /** Palavra ALTERAR, exigida quando o markup muda o preço de mais de 10 itens. */
  confirmacao: z.string().max(20).optional(),
});
const corpoPreviaMarkup = z.object({ markupPct: markupCampo });

const iguais = (a: string | null | undefined, b: string | null | undefined) =>
  a == null || b == null ? a == b : d(a).eq(d(b));

export async function rotasCatalogo(app: FastifyInstance) {
  const editar = { preHandler: exigir('catalogo.editar') };
  const editarPrecos = { preHandler: exigir('precos.editar') };

  async function markupPadrao(lojaId: string) {
    return (await parametro(app.db, lojaId, 'MARKUP_PADRAO_PCT')) ?? MARKUP_PADRAO_PCT;
  }
  const categorias = (lojaId: string) => carregarCategorias(app.db, lojaId);

  /** Junta à linha os dados da categoria (caminho, principal, perfil, markup). */
  function comCategoria<T extends { categoriaId: number }>(p: T, cats: CategoriaArvore[]) {
    const c = cats.find((x) => x.id === p.categoriaId);
    return {
      ...p,
      categoria: c?.caminho ?? '',
      categoriaPrincipalId: c?.principalId ?? null,
      categoriaPrincipal: c?.principal ?? '',
      perfil: c?.perfil ?? 'GENERICO',
      markupPct: c?.markupEfetivo ?? null,
      // Produto que ficou numa categoria com subcategorias (ex.: persiana antiga sem tipo).
      faltaSubcategoria: c?.temSubcategorias ?? false,
    };
  }

  /** Esconde custo de quem não tem `custos.ver`. */
  function filtrarCusto<T extends Record<string, unknown>>(req: FastifyRequest, o: T, chaves: string[]): T {
    if (pode(req.usuario!, 'custos.ver')) return o;
    const c = { ...o };
    for (const k of chaves) delete c[k];
    return c;
  }

  async function barrasDe(ids: string[]) {
    if (ids.length === 0) return new Map<string, { tamanhoM: number; custo: string; venda: string }[]>();
    const linhas = await app.db.select().from(precosBarraTrilho)
      .where(inArray(precosBarraTrilho.produtoId, ids)).orderBy(asc(precosBarraTrilho.tamanhoM));
    const m = new Map<string, { tamanhoM: number; custo: string; venda: string }[]>();
    for (const l of linhas) m.set(l.produtoId, [...(m.get(l.produtoId) ?? []), { tamanhoM: l.tamanhoM, custo: l.custo, venda: l.venda }]);
    return m;
  }

  const colunasLista = {
    id: produtos.id, sku: produtos.sku, nome: produtos.nome, corColecao: produtos.corColecao,
    categoriaId: produtos.categoriaId, categoria: categoriasProduto.nome,
    unidade: produtos.unidadeMedida, custoUnitario: produtos.custoUnitario,
    precoVendaUnitario: produtos.precoVendaUnitario, metadata: produtos.metadataTecnica,
    fornecedorPadraoId: produtos.fornecedorPadraoId, fornecedorNome: fornecedores.nomeFantasia,
    ativo: produtos.ativo, atualizadoEm: produtos.atualizadoEm,
    disponibilidade: produtos.disponibilidade, previsaoDisponivel: produtos.previsaoDisponivel,
  };

  function produtoPublico(req: FastifyRequest, p: Record<string, unknown>, barras: { tamanhoM: number; custo: string; venda: string }[]) {
    const base = filtrarCusto(req, p, ['custoUnitario']);
    if (!pode(req.usuario!, 'fornecedores.ver')) { delete base.fornecedorPadraoId; delete base.fornecedorNome; }
    return {
      ...base,
      // A tabela só vale no cálculo quando os 6 tamanhos estão preenchidos (regra do motor).
      tabelaBarrasCompleta: barras.length === 6,
      barras: barras.map((b) => filtrarCusto(req, b, ['custo'])),
    };
  }

  // Lista (também é o pacote do catálogo para o cálculo offline: o service worker guarda /api/catalogo/*).
  app.get('/api/catalogo/produtos', { preHandler: exigir('catalogo.ver') }, async (req, res) => {
    const f = filtros.safeParse(req.query);
    if (!f.success) return res.code(400).send({ erro: mensagemErro(f.error) });
    const cond: (SQL | undefined)[] = [];
    if (f.data.inativos !== '1' || !pode(req.usuario!, 'catalogo.editar')) cond.push(eq(produtos.ativo, true));
    if (f.data.categoriaId) cond.push(eq(produtos.categoriaId, f.data.categoriaId));
    if (f.data.q) cond.push(sql`${produtos.nomeBusca} LIKE f_busca(${termoLike(f.data.q)})`);
    const linhas = await app.db.select(colunasLista).from(produtos)
      .innerJoin(categoriasProduto, eq(categoriasProduto.id, produtos.categoriaId))
      .leftJoin(fornecedores, eq(fornecedores.id, produtos.fornecedorPadraoId))
      .where(and(...cond))
      .orderBy(asc(categoriasProduto.ordemExibicao), asc(produtos.sku));
    const barras = await barrasDe(linhas.map((l) => l.id));
    const cats = await categorias(req.usuario!.lojaId);
    return { produtos: linhas.map((p) => produtoPublico(req, comCategoria(p, cats), barras.get(p.id) ?? [])) };
  });

  app.get('/api/catalogo/categorias', { preHandler: exigir('catalogo.ver') }, async (req) => {
    const cats = await categorias(req.usuario!.lojaId);
    const verMarkup = pode(req.usuario!, 'custos.ver');
    return {
      categorias: verMarkup ? cats : cats.map(({ markupPct: _m, markupEfetivo: _e, markupOrigem: _o, ...c }) => c),
      markupPadraoPct: verMarkup ? await markupPadrao(req.usuario!.lojaId) : undefined,
    };
  });

  /** Nova subcategoria (sempre dentro de uma categoria existente; herda o tipo de cadastro). */
  app.post('/api/catalogo/categorias', editar, async (req, res) => {
    const corpo = corpoNovaCategoria.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const cats = await categorias(req.usuario!.lojaId);
    const pai = cats.find((c) => c.id === corpo.data.paiId);
    if (!pai) return res.code(400).send({ erro: 'Categoria de cima inválida.' });
    if (pai.nivel >= 2) return res.code(400).send({ erro: 'Máximo de 3 níveis (categoria › subcategoria › tipo).' });
    if (cats.some((c) => c.paiId === pai.id && c.nome.toLowerCase() === corpo.data.nome.toLowerCase())) {
      return res.code(409).send({ erro: `Já existe "${corpo.data.nome}" em ${pai.caminho}.` });
    }
    const [paiLinha] = await app.db.select().from(categoriasProduto).where(eq(categoriasProduto.id, pai.id));
    const ordem = Math.max(paiLinha!.ordemExibicao ?? 0, ...cats.filter((c) => c.paiId === pai.id).map((c) => c.ordem)) + 1;
    const [nova] = await app.db.insert(categoriasProduto).values({
      nome: corpo.data.nome, paiId: pai.id, tipoGrupo: paiLinha!.tipoGrupo, perfil: paiLinha!.perfil, ordemExibicao: ordem,
    }).returning({ id: categoriasProduto.id });
    const produtosNoPai = await app.db.select({ id: produtos.id }).from(produtos).where(eq(produtos.categoriaId, pai.id)).limit(1);
    return res.code(201).send({
      id: nova!.id,
      avisos: produtosNoPai.length ? [`${pai.caminho} já tem produtos: abra cada um e escolha a subcategoria.`] : [],
    });
  });

  /** Prévia da troca de markup: quais preços de venda mudam (nada é gravado). */
  app.post<{ Params: { id: string } }>('/api/catalogo/categorias/:id/markup/previa', editarPrecos, async (req, res) => {
    const corpo = corpoPreviaMarkup.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const cats = await categorias(req.usuario!.lojaId);
    const c = cats.find((x) => x.id === Number(req.params.id));
    const e = erroMarkupCategoria(c);
    if (e) return res.code(c ? 400 : 404).send({ erro: e });
    if (corpo.data.markupPct === null && c!.paiId === null) return res.code(400).send({ erro: 'Informe o markup.' });
    return previaMarkup(app.db, cats, c!, corpo.data.markupPct);
  });

  /**
   * Renomeia e/ou muda o markup. Markup só muda em categoria final (subcategoria); vazio = usa o da
   * categoria de cima. Mudar o markup RECALCULA a venda de todos os produtos da subcategoria
   * (e das barras do trilho). Sempre exige confirmacao = "ALTERAR".
   */
  app.patch<{ Params: { id: string } }>('/api/catalogo/categorias/:id', editarPrecos, async (req, res) => {
    const id = Number(req.params.id);
    const corpo = corpoEditarCategoria.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const cats = await categorias(req.usuario!.lojaId);
    const c = cats.find((x) => x.id === id);
    if (!c) return res.code(404).send({ erro: 'Categoria não encontrada.' });
    const mudar: Partial<typeof categoriasProduto.$inferInsert> = {};
    if (corpo.data.nome !== undefined && corpo.data.nome !== c.nome) {
      if (c.paiId === null) return res.code(400).send({ erro: 'As categorias principais têm nome fixo.' });
      if (cats.some((x) => x.paiId === c.paiId && x.id !== c.id && x.nome.toLowerCase() === corpo.data.nome!.toLowerCase())) {
        return res.code(409).send({ erro: `Já existe "${corpo.data.nome}" nesta categoria.` });
      }
      mudar.nome = corpo.data.nome;
    }
    const novoMarkup = corpo.data.markupPct;
    const mudaMarkup = novoMarkup !== undefined && (novoMarkup === null ? c.markupPct !== null : c.markupPct === null || !d(novoMarkup).eq(d(c.markupPct)));
    if (mudaMarkup) {
      const e = erroMarkupCategoria(c);
      if (e) return res.code(400).send({ erro: e });
      if (novoMarkup === null && c.paiId === null) return res.code(400).send({ erro: 'Informe o markup.' });
    }
    if (Object.keys(mudar).length === 0 && !mudaMarkup) return { ok: true, alterados: 0 };
    if (mudaMarkup) {
      const p = await previaMarkup(app.db, cats, c, novoMarkup!);
      // Markup: SEMPRE pede ALTERAR (Gabriel, 27/11/2026), mesmo sem produto na subcategoria.
      if (faltaConfirmacao(1, corpo.data.confirmacao, 0)) return res.code(428).send({ ...respostaConfirmacao(p.afetados), erro: `Mudar o markup de ${c.caminho} altera ${p.afetados} preço(s). Para continuar, digite ALTERAR e clique em Continuar.` });
    }
    const alterados = await app.db.transaction(async (tx) => {
      if (Object.keys(mudar).length) await tx.update(categoriasProduto).set(mudar).where(eq(categoriasProduto.id, id));
      if (!mudaMarkup) return 0;
      await tx.execute(sql`SELECT id FROM categorias_produto WHERE id = ${id} FOR UPDATE`);
      const previa = await previaMarkup(tx, cats, c, novoMarkup!);
      // Mudou algo entre a checagem e agora e passou de 10: pede de novo.
      if (faltaConfirmacao(1, corpo.data.confirmacao, 0)) throw Object.assign(new Error(respostaConfirmacao(previa.afetados).erro), { statusCode: 428 });
      await aplicarMarkup(tx, previa, novoMarkup!, req.usuario!.id);
      return previa.afetados;
    });
    return { ok: true, alterados, categoria: (await categorias(req.usuario!.lojaId)).find((x) => x.id === id) };
  });

  app.get('/api/catalogo/preco-sugerido', editarPrecos, async (req, res) => {
    const q = req.query as { custo?: string; categoriaId?: string };
    const c = valor.safeParse(q.custo ?? '');
    if (!c.success) return res.code(400).send({ erro: mensagemErro(c.error) });
    const padrao = await markupPadrao(req.usuario!.lojaId);
    const m = q.categoriaId ? markupDe(await categorias(req.usuario!.lojaId), Number(q.categoriaId), padrao) : padrao;
    return { custo: c.data, markupPct: m, precoVendaSugerido: precoVendaSugerido(c.data, m).toFixed(2) };
  });

  app.get<{ Params: { id: string } }>('/api/catalogo/produtos/:id', { preHandler: exigir('catalogo.ver') }, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Produto não encontrado.' });
    const [p] = await app.db.select(colunasLista).from(produtos)
      .innerJoin(categoriasProduto, eq(categoriasProduto.id, produtos.categoriaId))
      .leftJoin(fornecedores, eq(fornecedores.id, produtos.fornecedorPadraoId))
      .where(eq(produtos.id, req.params.id));
    if (!p || (!p.ativo && !pode(req.usuario!, 'catalogo.editar'))) return res.code(404).send({ erro: 'Produto não encontrado.' });
    const barras = (await barrasDe([p.id])).get(p.id) ?? [];
    const prod = comCategoria(p, await categorias(req.usuario!.lojaId));
    const resposta: Record<string, unknown> = { produto: produtoPublico(req, prod, barras), trilho: prod.perfil === 'TRILHO' };
    if (pode(req.usuario!, 'precos.editar')) {
      resposta.historico = await app.db.select({
        id: historicoPrecosProduto.id, tamanhoM: historicoPrecosProduto.tamanhoM,
        custoAnterior: historicoPrecosProduto.custoAnterior, custoNovo: historicoPrecosProduto.custoNovo,
        vendaAnterior: historicoPrecosProduto.vendaAnterior, vendaNova: historicoPrecosProduto.vendaNova,
        motivo: historicoPrecosProduto.motivo, alteradoEm: historicoPrecosProduto.alteradoEm, alteradoPor: usuarios.nome,
      }).from(historicoPrecosProduto)
        .leftJoin(usuarios, eq(usuarios.id, historicoPrecosProduto.alteradoPor))
        .where(eq(historicoPrecosProduto.produtoId, p.id))
        .orderBy(desc(historicoPrecosProduto.alteradoEm)).limit(200);
    }
    return resposta;
  });

  async function validarRefs(lojaId: string, categoriaId?: number, fornecedorId?: string | null) {
    if (categoriaId !== undefined) {
      const e = erroCategoriaProduto(await categorias(lojaId), categoriaId);
      if (e) return e;
    }
    if (fornecedorId) {
      const [f] = await app.db.select({ id: fornecedores.id }).from(fornecedores).where(eq(fornecedores.id, fornecedorId));
      if (!f) return 'Fornecedor inválido.';
    }
    return null;
  }

  app.post('/api/catalogo/produtos', editar, async (req, res) => {
    const corpo = corpoProduto.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const { motivo, precoVendaUnitario, ...dados } = corpo.data;
    const erroRef = await validarRefs(req.usuario!.lojaId, dados.categoriaId, dados.fornecedorPadraoId);
    if (erroRef) return res.code(400).send({ erro: erroRef });
    const erroPrev = ajustarPrevisao(dados);
    if (erroPrev) return res.code(400).send({ erro: erroPrev });
    const [existe] = await app.db.select({ id: produtos.id }).from(produtos).where(eq(produtos.sku, dados.sku));
    if (existe) return res.code(409).send({ erro: `Já existe produto com o SKU ${dados.sku}.` });
    const venda = precoVendaUnitario ?? precoVendaSugerido(dados.custoUnitario, markupDe(await categorias(req.usuario!.lojaId), dados.categoriaId)).toFixed(4);
    const novo = await app.db.transaction(async (tx) => {
      const [p] = await tx.insert(produtos).values({ ...dados, precoVendaUnitario: venda }).returning({ id: produtos.id });
      await tx.insert(historicoPrecosProduto).values({
        produtoId: p!.id, custoNovo: dados.custoUnitario, vendaNova: venda, alteradoPor: req.usuario!.id,
        motivo: motivo ?? 'Cadastro do produto',
      });
      return p!;
    });
    return res.code(201).send({ id: novo.id, precoVendaUnitario: venda, vendaSugerida: precoVendaUnitario == null });
  });

  app.patch<{ Params: { id: string } }>('/api/catalogo/produtos/:id', editar, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Produto não encontrado.' });
    const corpo = corpoEditarProduto.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const { motivo, ...dados } = corpo.data;
    const erroRef = await validarRefs(req.usuario!.lojaId, dados.categoriaId, dados.fornecedorPadraoId);
    if (erroRef) return res.code(400).send({ erro: erroRef });
    const erroPrev = ajustarPrevisao(dados);
    if (erroPrev) return res.code(400).send({ erro: erroPrev });
    if (dados.sku) {
      const [outro] = await app.db.select({ id: produtos.id }).from(produtos)
        .where(and(eq(produtos.sku, dados.sku), sql`${produtos.id} <> ${req.params.id}`));
      if (outro) return res.code(409).send({ erro: `Já existe produto com o SKU ${dados.sku}.` });
    }
    const resultado = await app.db.transaction(async (tx) => {
      const [atual] = await tx.select().from(produtos).where(eq(produtos.id, req.params.id)).for('update');
      if (!atual) return null;
      const mudancas: Partial<typeof produtos.$inferInsert> = { ...dados, precoVendaUnitario: dados.precoVendaUnitario ?? undefined };
      // Custo mudou e a venda não veio: mantém a venda atual (o ADMIN decide se reajusta).
      if (Object.values(mudancas).every((v) => v === undefined)) return 'nada' as const;
      const custoNovo = dados.custoUnitario ?? atual.custoUnitario;
      const vendaNova = dados.precoVendaUnitario ?? atual.precoVendaUnitario;
      const mudouPreco = !iguais(custoNovo, atual.custoUnitario) || !iguais(vendaNova, atual.precoVendaUnitario);
      await tx.update(produtos).set({ ...mudancas, atualizadoEm: sql`NOW()` }).where(eq(produtos.id, atual.id));
      if (mudouPreco) {
        await tx.insert(historicoPrecosProduto).values({
          produtoId: atual.id, custoAnterior: atual.custoUnitario, custoNovo, vendaAnterior: atual.precoVendaUnitario,
          vendaNova, alteradoPor: req.usuario!.id, motivo,
        });
      }
      return { mudouPreco };
    });
    if (resultado === null) return res.code(404).send({ erro: 'Produto não encontrado.' });
    if (resultado === 'nada') return res.code(400).send({ erro: 'Nada para alterar.' });
    return { ok: true, historicoRegistrado: resultado.mudouPreco };
  });

  /**
   * Tabela de preço por tamanho de barra (1 a 6 m), preenchida pelo ADMIN.
   * Cada linha enviada substitui aquele tamanho; custo e venda vazios apagam o tamanho.
   * Venda vazia com custo preenchido = sugestão pelo markup padrão.
   */
  app.put<{ Params: { id: string } }>('/api/catalogo/produtos/:id/barras', editarPrecos, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Produto não encontrado.' });
    const corpo = corpoBarras.safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const tamanhos = corpo.data.barras.map((b) => b.tamanhoM);
    if (new Set(tamanhos).size !== tamanhos.length) return res.code(400).send({ erro: 'Tamanho de barra repetido.' });
    const [p] = await app.db.select({ id: produtos.id, categoriaId: produtos.categoriaId }).from(produtos).where(eq(produtos.id, req.params.id));
    if (!p) return res.code(404).send({ erro: 'Produto não encontrado.' });
    const cats = await categorias(req.usuario!.lojaId);
    if (!cats.find((c) => c.id === p.categoriaId)?.trilho) return res.code(400).send({ erro: 'Tabela de barras só vale para produtos da categoria Trilhos e Varões.' });
    const m = markupDe(cats, p.categoriaId);

    const alteracoes = await app.db.transaction(async (tx) => {
      const atuais = new Map((await tx.select().from(precosBarraTrilho).where(eq(precosBarraTrilho.produtoId, p.id)).for('update'))
        .map((b) => [b.tamanhoM, b]));
      let n = 0;
      for (const b of corpo.data.barras) {
        const antes = atuais.get(b.tamanhoM);
        if (b.custo == null && b.venda == null) {
          if (!antes) continue;
          await tx.delete(precosBarraTrilho).where(and(eq(precosBarraTrilho.produtoId, p.id), eq(precosBarraTrilho.tamanhoM, b.tamanhoM)));
          await tx.insert(historicoPrecosProduto).values({
            produtoId: p.id, tamanhoM: b.tamanhoM, custoAnterior: antes.custo, vendaAnterior: antes.venda,
            alteradoPor: req.usuario!.id, motivo: corpo.data.motivo ?? 'Tamanho removido da tabela',
          });
          n++;
          continue;
        }
        if (b.custo == null) throw Object.assign(new Error(`Barra de ${b.tamanhoM} m: informe o custo.`), { statusCode: 400 });
        const venda = b.venda ?? precoVendaSugerido(b.custo, m).toFixed(4);
        if (antes && iguais(antes.custo, b.custo) && iguais(antes.venda, venda)) continue;
        await tx.insert(precosBarraTrilho).values({ produtoId: p.id, tamanhoM: b.tamanhoM, custo: b.custo, venda })
          .onConflictDoUpdate({
            target: [precosBarraTrilho.produtoId, precosBarraTrilho.tamanhoM],
            set: { custo: b.custo, venda, atualizadoEm: sql`NOW()` },
          });
        await tx.insert(historicoPrecosProduto).values({
          produtoId: p.id, tamanhoM: b.tamanhoM, custoAnterior: antes?.custo ?? null, custoNovo: b.custo,
          vendaAnterior: antes?.venda ?? null, vendaNova: venda, alteradoPor: req.usuario!.id, motivo: corpo.data.motivo,
        });
        n++;
      }
      return n;
    });
    const barras = (await barrasDe([p.id])).get(p.id) ?? [];
    const avisos = barras.length > 0 && barras.length < 6
      ? [`Faltam ${6 - barras.length} tamanho(s). Até completar os 6, o cálculo cobra este trilho por metro.`]
      : [];
    return { alteracoes, barras, tabelaBarrasCompleta: barras.length === 6, avisos };
  });

  // ---------------------------------------------------------------- importação de preços (só ADMIN)

  const corpoArquivo = z.object({
    arquivo: z.string().trim().min(1, 'Escolha o arquivo').max(200),
    conteudo: z.string().min(1, 'Arquivo vazio').max(14_000_000, 'Arquivo grande demais (máximo 10 MB).'),
  });
  const importar = { preHandler: exigir('catalogo.editar'), bodyLimit: 15 * 1024 * 1024 };

  function lerCorpoArquivo(body: unknown) {
    const c = corpoArquivo.safeParse(body);
    if (!c.success) return { erro: mensagemErro(c.error) };
    const nome = c.data.arquivo.replace(/^.*[\\/]/, '');
    try {
      return { nome, lido: lerArquivo(nome, Buffer.from(c.data.conteudo, 'base64')) };
    } catch (e) {
      if (e instanceof ErroPlanilha) return { erro: e.message };
      throw e;
    }
  }

  /** Planilha com o catálogo atual + códigos fixos que faltam, para preencher e importar. */
  app.get('/api/catalogo/importacao/planilha', { preHandler: exigir('catalogo.editar') }, async (req, res) => {
    const hoje = new Date().toISOString().slice(0, 10);
    return res.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="tabela-precos-${hoje}.xlsx"`)
      .send(await planilhaPrecos(app.db, req.usuario!.lojaId));
  });

  /** Prévia: lê a planilha e mostra o que vai mudar, sem gravar nada. */
  app.post('/api/catalogo/importacao/previa', importar, async (req, res) => {
    const r = lerCorpoArquivo(req.body);
    if ('erro' in r) return res.code(400).send({ erro: r.erro });
    return (await analisar(app.db, req.usuario!.lojaId, r.nome, r.lido)).previa;
  });

  /** Aplica a planilha (refaz a análise na hora; linhas com erro ficam de fora). */
  app.post('/api/catalogo/importacao/aplicar', importar, async (req, res) => {
    const r = lerCorpoArquivo(req.body);
    if ('erro' in r) return res.code(400).send({ erro: r.erro });
    // Trava de segurança: mais de 10 alterações = só com a palavra ALTERAR.
    const confirmacao = (req.body as { confirmacao?: unknown }).confirmacao;
    const antes = (await analisar(app.db, req.usuario!.lojaId, r.nome, r.lido)).previa.resumo;
    if (faltaConfirmacao(antes.criar + antes.atualizar, confirmacao)) return res.code(428).send(respostaConfirmacao(antes.criar + antes.atualizar));
    const { previa, importacaoId } = await aplicar(app.db, req.usuario!.lojaId, req.usuario!.id, r.nome, r.lido);
    if (!importacaoId) return res.code(400).send({ erro: 'Nada para aplicar: a planilha não muda nenhum preço.', previa });
    return res.code(201).send({ importacaoId, previa });
  });

  app.get('/api/catalogo/importacoes', { preHandler: exigir('catalogo.editar') }, async (req) => ({
    importacoes: await listarImportacoes(app.db, req.usuario!.lojaId),
  }));

  app.post<{ Params: { id: string } }>('/api/catalogo/importacoes/:id/desfazer', { preHandler: exigir('catalogo.editar') }, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Importação não encontrada.' });
    const [imp] = (await app.db.execute(sql`SELECT COUNT(*)::int AS n FROM importacoes_preco_itens WHERE importacao_id = ${req.params.id}`)).rows as { n: number }[];
    if (faltaConfirmacao(imp?.n ?? 0, (req.body as { confirmacao?: unknown } | undefined)?.confirmacao)) return res.code(428).send(respostaConfirmacao(imp!.n));
    const r = await desfazer(app.db, req.usuario!.lojaId, req.usuario!.id, req.params.id);
    if ('erro' in r) return res.code(r.status ?? 400).send({ erro: r.erro });
    return r;
  });
}
