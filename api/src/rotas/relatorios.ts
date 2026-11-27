import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { exigir } from '../auth/plugin.js';
import { mensagemErro } from '../cadastros/campos.js';
import { hojeLoja } from '../pedidos/dias-uteis.js';
import { rotinaFinanceira } from '../financeiro/servico.js';
import { gerarRelatorio } from '../relatorios/relatorios.js';
import { relatorioPdf, relatorioXlsx } from '../relatorios/exportar.js';
import { RELATORIOS, type TipoRelatorio } from '../relatorios/tipos.js';

/** Os 8 relatórios gerenciais (só ADMIN). ?formato=pdf|xlsx baixa o arquivo; sem formato devolve JSON para a tela. */

const dataTxt = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD).');
const textoBusca = z.string().trim().max(100).optional().transform((v) => v || undefined);

export async function rotasRelatorios(app: FastifyInstance) {
  const so = { preHandler: exigir('relatorios.ver') };

  app.get('/api/relatorios', so, async () => ({ relatorios: RELATORIOS }));

  app.get<{ Params: { tipo: string } }>('/api/relatorios/:tipo', so, async (req, res) => {
    const tipo = RELATORIOS.find((r) => r.id === req.params.tipo)?.id as TipoRelatorio | undefined;
    if (!tipo) return res.code(404).send({ erro: 'Relatório não encontrado.' });
    const hoje = hojeLoja();
    const q = z.object({
      de: dataTxt.default(`${hoje.slice(0, 8)}01`),
      ate: dataTxt.default(hoje),
      formato: z.enum(['json', 'pdf', 'xlsx']).default('json'),
      regime: z.enum(['competencia', 'caixa']).optional(),
      agrupar: z.enum(['dia', 'mes', 'ano']).optional(),
      nome: textoBusca, telefone: textoBusca, bairro: textoBusca, produto: textoBusca,
      forma: z.enum(['PIX', 'CREDITO_AVISTA', 'CREDITO_PARCELADO', 'DEBITO', 'BOLETO', 'DINHEIRO', 'MISTO']).optional(),
      instalacaoDe: dataTxt.optional(), instalacaoAte: dataTxt.optional(),
      usarPeriodo: z.enum(['1', '0', 'true', 'false']).optional().transform((v) => v === '1' || v === 'true'),
    }).safeParse(req.query);
    if (!q.success) return res.code(400).send({ erro: mensagemErro(q.error) });
    const { formato, ...f } = q.data;
    if (f.de > f.ate) return res.code(400).send({ erro: 'A data inicial é depois da final.' });
    if ((Date.parse(f.ate) - Date.parse(f.de)) / 86_400_000 > 3700) return res.code(400).send({ erro: 'Período longo demais (máximo 10 anos).' });
    const lojaId = req.usuario!.lojaId;
    await rotinaFinanceira(app.db, lojaId);
    const r = await gerarRelatorio(app.db, lojaId, tipo, f);
    if (formato === 'json') return { relatorio: r };
    const [loja] = (await app.db.execute<{ nome: string }>(sql`SELECT nome FROM lojas WHERE id = ${lojaId}`)).rows;
    const nome = `${tipo}-${f.de}-a-${f.ate}`;
    res.header('cache-control', 'no-store');
    if (formato === 'pdf') {
      return res.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${nome}.pdf"`)
        .send(await relatorioPdf(r, loja?.nome ?? 'Loja'));
    }
    return res.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${nome}.xlsx"`)
      .send(relatorioXlsx(r, loja?.nome ?? 'Loja'));
  });
}
