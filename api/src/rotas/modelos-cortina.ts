import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { exigir } from '../auth/plugin.js';
import { pode } from '../auth/permissoes.js';
import { mensagemErro } from '../cadastros/campos.js';
import { acessorioModelo } from '../orcamentos/esquemas.js';

/**
 * Modelos prontos de cortina (Gabriel, 28/11/2026). O ADMIN monta o modelo (tecido primário,
 * secundário opcional, trilho, acessórios de cada tecido e da cortina, mão de obra) e o vendedor
 * puxa o modelo no orçamento. Fica em /api/catalogo/* para o service worker guardar (uso offline).
 * O item do orçamento guarda uma cópia: editar ou excluir o modelo não muda orçamento já feito.
 */

const sku = z.string().trim().toUpperCase().min(2).max(30);
const skuOpcional = z.string().trim().toUpperCase().max(30).nullish().transform((v) => v || null);
const fator = z.union([z.string(), z.number()]).nullish().transform((v, ctx) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 1 || n > 5) { ctx.addIssue({ code: 'custom', message: 'Fator de franzimento: entre 1 e 5 (ex.: 2,8).' }); return z.NEVER; }
  return n.toFixed(2);
});

const corpoModelo = z.object({
  nome: z.string().trim().min(3, 'Dê um nome ao modelo (ex.: Cortina Wave Linho + Forro).').max(160),
  confeccao: z.enum(['WAVE', 'PREGA', 'FRANZIDO']),
  tecidoSku: sku,
  tecidoFator: fator,
  secundarioSku: skuOpcional,
  secundarioFator: fator,
  trilhoSku: sku,
  acessorios: z.array(acessorioModelo).max(30).default([]),
  maoObraSku: skuOpcional,
  instalacaoSku: skuOpcional,
  instalacaoAcima3Sku: skuOpcional,
  ativo: z.boolean().default(true),
});

type Linha = {
  id: string; nome: string; confeccao: string; tecidoSku: string; tecidoFator: string | null;
  secundarioSku: string | null; secundarioFator: string | null; trilhoSku: string; acessorios: unknown[];
  maoObraSku: string | null; instalacaoSku: string | null; instalacaoAcima3Sku: string | null; ativo: boolean; atualizadoEm: string;
};

const SELECT = sql`SELECT id, nome, confeccao, tecido_sku AS "tecidoSku", tecido_fator AS "tecidoFator",
  secundario_sku AS "secundarioSku", secundario_fator AS "secundarioFator", trilho_sku AS "trilhoSku", acessorios,
  mao_obra_sku AS "maoObraSku", instalacao_sku AS "instalacaoSku", instalacao_acima3_sku AS "instalacaoAcima3Sku",
  ativo, atualizado_em AS "atualizadoEm" FROM modelos_cortina`;

/** Nome repetido (o erro do Postgres pode vir dentro de `cause`, conforme o driver). */
const duplicado = (e: unknown) => [e, (e as { cause?: unknown })?.cause].some((x) => (x as { code?: string } | undefined)?.code === '23505');

export async function rotasModelosCortina(app: FastifyInstance) {
  const editar = { preHandler: exigir('catalogo.editar') };

  /** Todo SKU do modelo precisa existir no Catálogo (ativo ou não). */
  async function skusFaltando(m: z.infer<typeof corpoModelo>): Promise<string[]> {
    const todos = [m.tecidoSku, m.secundarioSku, m.trilhoSku, m.maoObraSku, m.instalacaoSku, m.instalacaoAcima3Sku, ...m.acessorios.map((a) => a.sku)]
      .filter((x): x is string => Boolean(x));
    const unicos = [...new Set(todos)];
    const { rows } = await app.db.execute(sql`SELECT sku FROM produtos WHERE sku IN (${sql.join(unicos.map((s) => sql`${s}`), sql`, `)})`);
    const achados = new Set((rows as { sku: string }[]).map((r) => r.sku));
    return unicos.filter((s) => !achados.has(s));
  }

  function validar(m: z.infer<typeof corpoModelo>): string | null {
    if (m.secundarioSku && m.secundarioSku === m.tecidoSku) return 'O tecido secundário é igual ao primário.';
    if (!m.secundarioSku && m.acessorios.some((a) => a.aplica === 'SECUNDARIO')) return 'Há acessórios do tecido secundário, mas o modelo não tem tecido secundário.';
    if (m.acessorios.some((a) => a.regra === 'ENTRETELA' && (a.aplica !== 'PRIMARIO' || m.confeccao !== 'WAVE'))) {
      return 'Entretela só vale para cortina Wave e só no tecido primário.';
    }
    return null;
  }

  app.get('/api/catalogo/modelos-cortina', { preHandler: exigir('catalogo.ver') }, async (req) => {
    const todos = (req.query as { inativos?: string }).inativos === '1' && pode(req.usuario!, 'catalogo.editar');
    const { rows } = await app.db.execute(todos ? sql`${SELECT} ORDER BY nome` : sql`${SELECT} WHERE ativo ORDER BY nome`);
    return { modelos: rows as Linha[] };
  });

  app.post('/api/catalogo/modelos-cortina', editar, async (req, res) => {
    const c = corpoModelo.safeParse(req.body);
    if (!c.success) return res.code(400).send({ erro: mensagemErro(c.error) });
    const m = c.data;
    const erro = validar(m);
    if (erro) return res.code(400).send({ erro });
    const faltam = await skusFaltando(m);
    if (faltam.length) return res.code(400).send({ erro: `Não achei no Catálogo: ${faltam.join(', ')}.` });
    try {
      const { rows } = await app.db.execute(sql`INSERT INTO modelos_cortina (nome, confeccao, tecido_sku, tecido_fator, secundario_sku, secundario_fator,
          trilho_sku, acessorios, mao_obra_sku, instalacao_sku, instalacao_acima3_sku, ativo)
        VALUES (${m.nome}, ${m.confeccao}, ${m.tecidoSku}, ${m.tecidoFator}, ${m.secundarioSku}, ${m.secundarioFator},
          ${m.trilhoSku}, ${JSON.stringify(m.acessorios)}::jsonb, ${m.maoObraSku}, ${m.instalacaoSku}, ${m.instalacaoAcima3Sku}, ${m.ativo})
        RETURNING id`);
      return res.code(201).send({ id: (rows[0] as { id: string }).id });
    } catch (e) {
      if (duplicado(e)) return res.code(409).send({ erro: `Já existe um modelo chamado "${m.nome}".` });
      throw e;
    }
  });

  app.put<{ Params: { id: string } }>('/api/catalogo/modelos-cortina/:id', editar, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Modelo não encontrado.' });
    const c = corpoModelo.safeParse(req.body);
    if (!c.success) return res.code(400).send({ erro: mensagemErro(c.error) });
    const m = c.data;
    const erro = validar(m);
    if (erro) return res.code(400).send({ erro });
    const faltam = await skusFaltando(m);
    if (faltam.length) return res.code(400).send({ erro: `Não achei no Catálogo: ${faltam.join(', ')}.` });
    try {
      const { rows } = await app.db.execute(sql`UPDATE modelos_cortina SET nome = ${m.nome}, confeccao = ${m.confeccao},
          tecido_sku = ${m.tecidoSku}, tecido_fator = ${m.tecidoFator}, secundario_sku = ${m.secundarioSku}, secundario_fator = ${m.secundarioFator},
          trilho_sku = ${m.trilhoSku}, acessorios = ${JSON.stringify(m.acessorios)}::jsonb, mao_obra_sku = ${m.maoObraSku},
          instalacao_sku = ${m.instalacaoSku}, instalacao_acima3_sku = ${m.instalacaoAcima3Sku}, ativo = ${m.ativo}, atualizado_em = NOW()
        WHERE id = ${req.params.id} RETURNING id`);
      if (rows.length === 0) return res.code(404).send({ erro: 'Modelo não encontrado.' });
      return { id: req.params.id };
    } catch (e) {
      if (duplicado(e)) return res.code(409).send({ erro: `Já existe um modelo chamado "${m.nome}".` });
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/catalogo/modelos-cortina/:id', editar, async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.code(404).send({ erro: 'Modelo não encontrado.' });
    const { rows } = await app.db.execute(sql`DELETE FROM modelos_cortina WHERE id = ${req.params.id} RETURNING id`);
    if (rows.length === 0) return res.code(404).send({ erro: 'Modelo não encontrado.' });
    return { ok: true };
  });
}
