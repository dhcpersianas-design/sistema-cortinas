import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { exigir } from '../auth/plugin.js';
import { mensagemErro, textoOpcional } from '../cadastros/campos.js';
import { ErroPedido } from '../pedidos/servico.js';
import { ErroOrcamento } from '../orcamentos/servico.js';
import {
  agendarMedicao, apagarFoto, cancelarMedicao, conferirMedicao, ErroMedicao, lerFoto, listarAgenda, medicoesDoOrcamento,
  montarMedicao, pacoteOffline, projetosDoCliente, registrarMedicao, remarcarMedicao, salvarFoto,
} from '../medicoes/servico.js';
import { hojeLoja, somarDiasUteis } from '../pedidos/dias-uteis.js';

/**
 * Agenda e medição técnica no local (especificação v1.1, seção 9 etapa 2 e 12.5).
 * VENDEDOR: as visitas dele (marcar, registrar na obra sem internet, fotos e conferir).
 * ADMIN: todas, escolhendo o responsável, e a agenda da equipe.
 */

const uuid = z.uuid();
const dataTxt = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD).');
const dataHora = z.iso.datetime({ offset: true, message: 'Data/hora inválida.' });
const horas = z.union([z.string(), z.number()]).nullish().transform((v, ctx) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d)?$/.test(s) || Number(s) <= 0 || Number(s) > 24) { ctx.addIssue({ code: 'custom', message: 'Duração inválida (em horas).' }); return z.NEVER; }
  return s;
});

/** Medida em metros (o app converte de centímetros). Mesmos limites de sanidade do orçamento (12.5). */
const medida = (rotulo: string, max: number) => z.union([z.string(), z.number()]).transform((v, ctx) => {
  const s = String(v).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,4})?$/.test(s) || Number(s) <= 0) { ctx.addIssue({ code: 'custom', message: `${rotulo} inválida: "${v}"` }); return z.NEVER; }
  if (Number(s) > max) { ctx.addIssue({ code: 'custom', message: `${rotulo} fora do normal (máximo ${max} m). Confira se digitou em centímetros.` }); return z.NEVER; }
  return s;
});

const vao = z.object({
  id: z.string().trim().min(1).max(40),
  ambiente: z.string().trim().min(1, 'Informe o ambiente de cada vão').max(100),
  descricao: z.string().trim().max(150).default(''),
  tipo: z.enum(['CORTINA', 'PERSIANA']),
  modo: z.enum(['DENTRO_VAO', 'FORA_VAO', 'TETO']).nullish().transform((v) => v ?? null),
  larguras: z.array(medida('Largura', 15)).min(1, 'Informe a largura de cada vão').max(3),
  alturas: z.array(medida('Altura', 10)).min(1, 'Informe a altura de cada vão').max(3),
  ladoComando: z.enum(['DIREITO', 'ESQUERDO']).nullish().transform((v) => v ?? null),
  profundidadeCortineiroM: medida('Profundidade do cortineiro', 2).nullish().transform((v) => v ?? null),
  observacoes: textoOpcional(500),
  itemId: z.string().max(60).nullish().transform((v) => v ?? null),
}).transform((v) => (v.tipo === 'PERSIANA' ? { ...v, modo: v.modo ?? 'DENTRO_VAO' } : v));

export async function rotasMedicoes(app: FastifyInstance) {
  const ver = { preHandler: exigir('medicoes.proprias') };

  function falhar(res: FastifyReply, e: unknown) {
    if (e instanceof ErroMedicao || e instanceof ErroPedido || e instanceof ErroOrcamento) {
      return res.code(e.status).send({ erro: e.message, ...e.extra });
    }
    throw e;
  }
  const idValido = (req: FastifyRequest<{ Params: { id: string } }>, res: FastifyReply) => {
    if (uuid.safeParse(req.params.id).success) return true;
    res.code(404).send({ erro: 'Medição não encontrada.' });
    return false;
  };
  const responder = async (req: FastifyRequest, id: string, extra: Record<string, unknown> = {}) =>
    ({ medicao: await montarMedicao(app.db, req.usuario!, id), ...extra });

  /** Agenda do período: medições + instalações, e as pendências (sem visita, atrasadas, a conferir). */
  app.get('/api/agenda', ver, async (req, res) => {
    const f = z.object({ de: dataTxt.optional(), ate: dataTxt.optional(), responsavel: uuid.optional() }).safeParse(req.query);
    if (!f.success) return res.code(400).send({ erro: mensagemErro(f.error) });
    const de = f.data.de ?? hojeLoja();
    const ate = f.data.ate ?? somarDiasUteis(de, 10);
    if (ate < de) return res.code(400).send({ erro: 'Período inválido.' });
    return listarAgenda(app.db, req.usuario!, { de, ate, responsavelId: f.data.responsavel ?? null });
  });

  app.get<{ Params: { id: string } }>('/api/clientes/:id/projetos', ver, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Cliente não encontrado.' });
    return { projetos: await projetosDoCliente(app.db, req.usuario!, req.params.id) };
  });

  app.post('/api/medicoes', ver, async (req, res) => {
    const corpo = z.object({
      clienteId: uuid, orcamentoId: uuid.nullish(), dataAgendada: dataHora, duracaoHoras: horas,
      responsavelId: uuid.nullish(), observacoes: textoOpcional(1000),
    }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    try {
      const r = await agendarMedicao(app.db, req.usuario!, corpo.data);
      return res.code(201).send(await responder(req, r.id, { avisos: r.avisos }));
    } catch (e) { return falhar(res, e); }
  });

  /** Pacote para a obra: visitas do usuário, com cliente, endereço e itens do orçamento. */
  app.get('/api/medicoes/pacote-offline', ver, async (req) => pacoteOffline(app.db, req.usuario!));

  app.get<{ Params: { id: string } }>('/api/medicoes/:id', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    try { return await responder(req, req.params.id); } catch (e) { return falhar(res, e); }
  });

  app.post<{ Params: { id: string } }>('/api/medicoes/:id/remarcar', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({ dataAgendada: dataHora, duracaoHoras: horas, responsavelId: uuid.nullish(), observacoes: textoOpcional(1000) }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    try {
      const r = await remarcarMedicao(app.db, req.usuario!, req.params.id, corpo.data);
      return await responder(req, req.params.id, { avisos: r.avisos });
    } catch (e) { return falhar(res, e); }
  });

  app.post<{ Params: { id: string } }>('/api/medicoes/:id/cancelar', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({ motivo: z.string().trim().min(3, 'Informe o motivo').max(200) }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    try { await cancelarMedicao(app.db, req.usuario!, req.params.id, corpo.data.motivo); return await responder(req, req.params.id); }
    catch (e) { return falhar(res, e); }
  });

  /** Vãos medidos na obra (pode chegar depois, da fila do aparelho). */
  app.post<{ Params: { id: string } }>('/api/medicoes/:id/registro', { ...ver, bodyLimit: 2_000_000 }, async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({
      registroId: uuid,
      vaos: z.array(vao).min(1, 'Registre ao menos um vão.').max(80),
      obsCampo: textoOpcional(2000),
      realizadaEm: dataHora,
      offline: z.boolean().optional(),
    }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    // Relógio do aparelho adiantado: não aceita data no futuro.
    if (new Date(corpo.data.realizadaEm).getTime() > Date.now() + 10 * 60_000) corpo.data.realizadaEm = new Date().toISOString();
    try {
      const r = await registrarMedicao(app.db, req.usuario!, req.params.id, corpo.data);
      return res.code(r.repetido ? 200 : 201).send(await responder(req, req.params.id, { repetido: r.repetido }));
    } catch (e) { return falhar(res, e); }
  });

  /** Uma foto por chamada (JPEG/PNG/WebP em base64, até ~3 MB). */
  app.post<{ Params: { id: string } }>('/api/medicoes/:id/fotos', { ...ver, bodyLimit: 5_000_000 }, async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({
      id: uuid,
      vaoId: z.string().max(40).nullish().transform((v) => v ?? null),
      legenda: textoOpcional(120),
      dataUrl: z.string().max(4_500_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'Foto inválida (use JPEG, PNG ou WebP).'),
    }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: mensagemErro(corpo.error) });
    const [cab, b64] = corpo.data.dataUrl.split(',', 2);
    const mime = cab!.slice(5, cab!.indexOf(';'));
    const conteudo = Buffer.from(b64!, 'base64');
    if (conteudo.length < 100) return res.code(400).send({ erro: 'Foto vazia.' });
    try {
      const r = await salvarFoto(app.db, req.usuario!, req.params.id, { id: corpo.data.id, vaoId: corpo.data.vaoId, legenda: corpo.data.legenda, mime, conteudo });
      return res.code(r.repetida ? 200 : 201).send({ ok: true, repetida: r.repetida });
    } catch (e) { return falhar(res, e); }
  });

  app.delete<{ Params: { id: string; foto: string } }>('/api/medicoes/:id/fotos/:foto', ver, async (req, res) => {
    if (!idValido(req, res) || !uuid.safeParse(req.params.foto).success) return res.code(404).send({ erro: 'Foto não encontrada.' });
    try { await apagarFoto(app.db, req.usuario!, req.params.id, req.params.foto); return { ok: true }; }
    catch (e) { return falhar(res, e); }
  });

  app.get<{ Params: { foto: string } }>('/api/medicoes/fotos/:foto', ver, async (req, res) => {
    if (!uuid.safeParse(req.params.foto).success) return res.code(404).send({ erro: 'Foto não encontrada.' });
    const f = await lerFoto(app.db, req.usuario!, req.params.foto);
    if (!f) return res.code(404).send({ erro: 'Foto não encontrada.' });
    return res.header('content-type', f.mime).header('cache-control', 'private, max-age=86400').send(f.conteudo);
  });

  /** Conferência: alterou = as medidas da obra mudam o que foi vendido/orçado. */
  app.post<{ Params: { id: string } }>('/api/medicoes/:id/conferir', ver, async (req, res) => {
    if (!idValido(req, res)) return;
    const corpo = z.object({ alterou: z.boolean() }).safeParse(req.body);
    if (!corpo.success) return res.code(400).send({ erro: 'Diga se as medidas mudaram ou não.' });
    try {
      const r = await conferirMedicao(app.db, req.usuario!, req.params.id, corpo.data.alterou);
      return await responder(req, req.params.id, { resultado: r });
    } catch (e) { return falhar(res, e); }
  });

  /** Medidas tiradas no local para o configurador do orçamento. */
  app.get<{ Params: { id: string } }>('/api/orcamentos/:id/medicoes', { preHandler: exigir('orcamentos.proprios') }, async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    const r = await medicoesDoOrcamento(app.db, req.usuario!, req.params.id);
    if (!r) return res.code(404).send({ erro: 'Orçamento não encontrado.' });
    return { medicoes: r };
  });
}
