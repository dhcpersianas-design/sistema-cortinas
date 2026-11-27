import { sql, type SQL } from 'drizzle-orm';
import { d, descontoValeNaForma, dinheiro } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import type { UsuarioSessao } from '../auth/sessao.js';
import { pode } from '../auth/permissoes.js';
import { parametro } from '../catalogo/parametros.js';
import {
  auditar, criarVersao, lerCabecalho, lerDocumento, noEscopo, recalcularTotais, situacaoLiberacao,
} from '../orcamentos/servico.js';
import { hojeLoja, somarDiasUteis } from './dias-uteis.js';
import {
  ajustarPorAditivo, atualizarVencimentoSaldo, cancelarFinanceiroPedido, criarPlanoRecebimento, ErroFinanceiro, lucroPedidos,
  receberDoCliente, sincronizarComissao, sincronizarPagarInstalacao, sincronizarPagarOrdem, situacaoCliente, somarDias,
} from '../financeiro/servico.js';

/**
 * Pedido, compras, produção e instalação (especificação v1.1, seção 9 etapas 3 a 6, e 12.4).
 *
 * Caminho do pedido:
 *   orçamento aprovado -> CONFERENCIA_MEDIDAS (venda fechada antes da medição; não libera compras)
 *                      -> AGUARDANDO_SINAL -> EM_COMPRA -> EM_PRODUCAO -> PRONTO_ESTOQUE
 *                      -> INSTALACAO_AGENDADA -> INSTALADO_CONCLUIDO (aceite do cliente)
 *   CANCELADO pode vir de qualquer etapa antes da instalação.
 *
 * Depois de aprovado o orçamento não é mais editado: mudança vira ADITIVO, que é uma nova versão
 * do orçamento (rascunho editado no mesmo configurador) ligada ao pedido. Confirmar o aditivo troca a
 * versão que vale no pedido, registra a diferença de valor e, se as compras já saíram, gera as
 * ordens de compra complementares.
 */

type Tx = Parameters<Parameters<Banco['transaction']>[0]>[0];
type Exec = Banco | Tx;

export class ErroPedido extends Error {
  constructor(message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); }
}

async function linhas<T>(db: Exec, q: SQL): Promise<T[]> {
  return (await db.execute(q)).rows as T[];
}

/** Categoria "Serviços de Instalação" (id fixo da migração 0002): não vira compra, é do instalador. */
export const CATEGORIA_INSTALACAO = 9;

export const STATUS_PEDIDO: Record<string, string> = {
  CONFERENCIA_MEDIDAS: 'Conferência de medidas',
  AGUARDANDO_SINAL: 'Aguardando sinal',
  EM_COMPRA: 'Em compra',
  EM_PRODUCAO: 'Em produção',
  PRONTO_ESTOQUE: 'Pronto para instalar',
  INSTALACAO_AGENDADA: 'Instalação agendada',
  INSTALADO_CONCLUIDO: 'Instalado',
  CANCELADO: 'Cancelado',
};

/** Etapas em que as compras já foram liberadas (o status segue as ordens de compra). */
const ETAPAS_COMPRA = ['EM_COMPRA', 'EM_PRODUCAO', 'PRONTO_ESTOQUE', 'INSTALACAO_AGENDADA'];
/** Etapas em que cabe aditivo de alteração (antes disso é a conferência de medidas). */
const ETAPAS_ADITIVO = ['AGUARDANDO_SINAL', ...ETAPAS_COMPRA];
/** Etapas em que dá para agendar (pré-agendar antes de ficar pronto é permitido). */
const ETAPAS_AGENDA = ETAPAS_COMPRA;

// ------------------------------------------------------------------ leitura

export type CabecalhoPedido = {
  id: string; lojaId: string; numero: string; orcamentoId: string; grupoId: string; orcamentoAprovadoId: string | null;
  orcamentoCodigo: string; orcamentoVersao: number; titulo: string | null;
  clienteId: string; clienteNome: string; clienteTelefone: string; clienteEndereco: string | null; clienteObsAcesso: string | null;
  vendedorId: string; vendedorNome: string;
  status: string; dataCompra: string; previsaoEntrega: string | null;
  instalacaoAgendada: string | null; duracaoHoras: string | null; instalacaoRealizada: string | null;
  instaladorId: string | null; instaladorNome: string | null; instaladorWhatsapp: string | null;
  formaPagamento: string | null; valorTotal: string; valorOriginal: string | null; custoPrevisto: string; custoReal: string | null;
  sinalValor: string | null; sinalForma: string | null; sinalRecebidoEm: string | null;
  comprasLiberadasEm: string | null; liberadoSemSinal: boolean; medidasConferidasEm: string | null;
  obsInstalacao: string | null; checklist: unknown;
  canceladoEm: string | null; motivoCancelamento: string | null;
  nfeNumero: string | null; nfeChave: string | null; nfseNumero: string | null; nfRegistradaEm: string | null;
  prazoEntregaDias: number | null; atualizadoEm: string;
};

const SELECT_PEDIDO = sql`
  SELECT p.id, p.loja_id AS "lojaId", p.numero_pedido AS numero, p.orcamento_id AS "orcamentoId", p.grupo_orcamento_id AS "grupoId",
         p.orcamento_aprovado_id AS "orcamentoAprovadoId", o.codigo_sequencial AS "orcamentoCodigo", o.versao AS "orcamentoVersao",
         p.titulo, p.cliente_id AS "clienteId", c.nome_completo AS "clienteNome", c.telefone_whatsapp AS "clienteTelefone",
         NULLIF(CONCAT_WS(', ', NULLIF(CONCAT_WS(' ', c.logradouro, c.numero), ''), c.complemento, c.bairro,
           NULLIF(CONCAT_WS(' - ', c.cidade, c.uf), ''), CASE WHEN c.cep IS NOT NULL THEN 'CEP ' || c.cep END), '') AS "clienteEndereco",
         c.obs_acesso_instalacao AS "clienteObsAcesso",
         p.vendedor_id AS "vendedorId", u.nome AS "vendedorNome",
         p.status_operacional AS status, p.data_compra AS "dataCompra", to_char(p.data_previsao_entrega, 'YYYY-MM-DD') AS "previsaoEntrega",
         p.data_instalacao_agendada AS "instalacaoAgendada", p.instalacao_duracao_horas AS "duracaoHoras",
         p.data_instalacao_realizada AS "instalacaoRealizada",
         p.instalador_fornecedor_id AS "instaladorId", f.nome_fantasia AS "instaladorNome", f.whatsapp AS "instaladorWhatsapp",
         p.forma_pagamento_final AS "formaPagamento", p.valor_total_final AS "valorTotal", p.valor_original AS "valorOriginal",
         o.custo_total_previsto AS "custoPrevisto", p.custo_real_consolidado AS "custoReal",
         p.sinal_valor AS "sinalValor", p.sinal_forma AS "sinalForma", to_char(p.sinal_recebido_em, 'YYYY-MM-DD') AS "sinalRecebidoEm",
         p.compras_liberadas_em AS "comprasLiberadasEm", p.liberado_sem_sinal AS "liberadoSemSinal",
         p.medidas_conferidas_em AS "medidasConferidasEm", p.obs_instalacao AS "obsInstalacao", p.checklist_instalacao AS checklist,
         p.cancelado_em AS "canceladoEm", p.motivo_cancelamento AS "motivoCancelamento",
         p.nfe_numero AS "nfeNumero", p.nfe_chave AS "nfeChave", p.nfse_numero AS "nfseNumero", p.nf_registrada_em AS "nfRegistradaEm",
         o.prazo_entrega_dias AS "prazoEntregaDias", p.atualizado_em AS "atualizadoEm"
    FROM pedidos p
    JOIN orcamentos o ON o.id = p.orcamento_id
    JOIN clientes c ON c.id = p.cliente_id
    JOIN usuarios u ON u.id = p.vendedor_id
    LEFT JOIN fornecedores f ON f.id = p.instalador_fornecedor_id`;

export async function lerPedido(db: Exec, id: string): Promise<CabecalhoPedido | null> {
  const [p] = await linhas<CabecalhoPedido>(db, sql`${SELECT_PEDIDO} WHERE p.id = ${id}`);
  return p ?? null;
}

/** VENDEDOR: só os pedidos dele. */
export function pedidoNoEscopo(u: UsuarioSessao, p: { lojaId: string; vendedorId: string }) {
  return p.lojaId === u.lojaId && (pode(u, 'pedidos.todos') || p.vendedorId === u.id);
}

async function pedidoDoUsuario(db: Exec, u: UsuarioSessao, id: string, travar = false): Promise<CabecalhoPedido> {
  if (travar) await db.execute(sql`SELECT id FROM pedidos WHERE id = ${id} FOR UPDATE`);
  const p = await lerPedido(db, id);
  if (!p || !pedidoNoEscopo(u, p)) throw new ErroPedido('Pedido não encontrado.', 404);
  return p;
}

type AditivoLinha = {
  id: string; numero: number; tipo: 'CONFERENCIA_MEDIDAS' | 'ALTERACAO'; status: string; motivo: string | null;
  orcamentoAnteriorId: string; orcamentoNovoId: string | null; valorAnterior: string; valorNovo: string | null; diferenca: string | null;
  criadoEm: string; criadoPor: string | null; confirmadoEm: string | null;
};

async function lerAditivos(db: Exec, pedidoId: string) {
  return linhas<AditivoLinha>(db, sql`
    SELECT a.id, a.numero, a.tipo, a.status, a.motivo, a.orcamento_anterior_id AS "orcamentoAnteriorId",
           a.orcamento_novo_id AS "orcamentoNovoId", a.valor_anterior AS "valorAnterior", a.valor_novo AS "valorNovo",
           a.diferenca, a.criado_em AS "criadoEm", u.nome AS "criadoPor", a.confirmado_em AS "confirmadoEm"
      FROM pedido_aditivos a LEFT JOIN usuarios u ON u.id = a.criado_por_id
     WHERE a.pedido_id = ${pedidoId} ORDER BY a.numero`);
}

/** Rascunho do aditivo em aberto: a versão mais nova do projeto, ainda rascunho e ligada ao pedido. */
async function rascunhoDoAditivo(db: Exec, p: CabecalhoPedido) {
  const [r] = await linhas<{ id: string; versao: number }>(db, sql`
    SELECT id, versao FROM orcamentos WHERE grupo_id = ${p.grupoId} AND status = 'RASCUNHO' AND aditivo_pedido_id = ${p.id}
     ORDER BY versao DESC LIMIT 1`);
  return r ?? null;
}

// ------------------------------------------------------------------ histórico

export async function registrarEvento(
  db: Exec, pedidoId: string, usuarioId: string | null, acao: string, descricao: string,
  detalhes: Record<string, unknown> = {}, offline = false,
) {
  await db.execute(sql`
    INSERT INTO pedido_eventos (pedido_id, usuario_id, acao, descricao, detalhes, offline)
    VALUES (${pedidoId}, ${usuarioId}, ${acao}, ${descricao}, ${JSON.stringify(detalhes)}::jsonb, ${offline})`);
}

async function mudarStatus(tx: Exec, p: Pick<CabecalhoPedido, 'id' | 'status'>, novo: string, usuarioId: string | null, complemento = '') {
  if (p.status === novo) return;
  await tx.execute(sql`UPDATE pedidos SET status_operacional = ${novo}::status_pedido_enum, atualizado_em = NOW() WHERE id = ${p.id}`);
  await registrarEvento(tx, p.id, usuarioId, 'STATUS', `${STATUS_PEDIDO[novo] ?? novo}.${complemento ? ` ${complemento}` : ''}`, { de: p.status, para: novo });
}

/** Previsão de entrega: prazo do orçamento (dias úteis) contado a partir de hoje, o dia em que as medidas foram conferidas. */
async function previsaoEntrega(tx: Exec, p: Pick<CabecalhoPedido, 'lojaId' | 'prazoEntregaDias'>, inicio = hojeLoja()): Promise<string> {
  const prazo = p.prazoEntregaDias ?? Number((await parametro(tx as Banco, p.lojaId, 'PRAZO_ENTREGA_DIAS_UTEIS')) ?? 14);
  return somarDiasUteis(inicio, prazo);
}

// ------------------------------------------------------------------ aprovação (orçamento -> pedido)

export type EntradaAprovacao = { formaPagamento?: string | null; medidasConferidas?: boolean; observacao?: string };

/**
 * Aprova a versão enviada do orçamento e cria o pedido (1 por projeto).
 * Medidas não conferidas no local -> o pedido nasce em CONFERENCIA_MEDIDAS e não libera compras.
 */
export async function aprovarOrcamento(db: Banco, u: UsuarioSessao, orcamentoId: string, e: EntradaAprovacao) {
  return db.transaction(async (tx) => {
    const c = await lerCabecalho(tx, orcamentoId);
    if (!c || !noEscopo(u, c)) throw new ErroPedido('Orçamento não encontrado.', 404);
    await tx.execute(sql`SELECT id FROM orcamentos WHERE grupo_id = ${c.grupoId} FOR UPDATE`);
    if (c.pedidoId) throw new ErroPedido(`Este projeto já virou o pedido ${c.pedidoNumero}.`, 409, { pedidoId: c.pedidoId });
    if (c.versaoMaisNovaId !== c.id) throw new ErroPedido(`Aprove a versão mais nova (v${c.versaoMaisNova}).`, 409);
    if (c.status === 'RASCUNHO') throw new ErroPedido('Envie a proposta ao cliente antes de aprovar (a versão aprovada precisa estar congelada).', 409);
    if (!['ENVIADO', 'AGUARDANDO_MEDICAO', 'EM_NEGOCIACAO'].includes(c.status)) {
      throw new ErroPedido(`Orçamento ${c.status.toLowerCase()} não pode ser aprovado.`, 409);
    }
    if (situacaoLiberacao(c).pendente) throw new ErroPedido('Precisa da senha do administrador antes de aprovar.', 409, { exigeLiberacao: true });

    const conferidas = e.medidasConferidas ?? c.medidasConferidas;
    const status = conferidas ? 'AGUARDANDO_SINAL' : 'CONFERENCIA_MEDIDAS';
    const forma = e.formaPagamento === undefined ? c.formaPagamento : e.formaPagamento;
    // O desconto do orçamento só vale no PIX: aprovado em cartão/débito/dinheiro, o pedido fica pelo valor cheio.
    const valor = descontoValeNaForma(forma) ? c.total : d(c.subtotal).plus(c.acrescimo).toFixed(2);
    const [n] = await linhas<{ n: string }>(tx, sql`SELECT nextval('pedido_numero_seq')::text AS n`);
    const numero = `PED-${hojeLoja().slice(0, 4)}-${n!.n.padStart(4, '0')}`;
    const previsao = conferidas ? await previsaoEntrega(tx, { lojaId: c.lojaId, prazoEntregaDias: c.prazoEntregaDias }) : null;

    const [p] = await linhas<{ id: string }>(tx, sql`
      INSERT INTO pedidos (loja_id, numero_pedido, orcamento_id, grupo_orcamento_id, orcamento_aprovado_id, cliente_id, vendedor_id,
        status_operacional, data_previsao_entrega, forma_pagamento_final, valor_total_final, valor_original, titulo, criado_por_id,
        medidas_conferidas_em, medidas_conferidas_por_id)
      VALUES (${c.lojaId}, ${numero}, ${c.id}, ${c.grupoId}, ${c.id}, ${c.clienteId}, ${c.vendedorId},
        ${status}::status_pedido_enum, ${previsao}::date, ${forma ?? null}::forma_pagamento_enum, ${valor}, ${valor}, ${c.titulo}, ${u.id},
        ${conferidas ? sql`NOW()` : null}, ${conferidas ? u.id : null})
      RETURNING id`);
    await tx.execute(sql`UPDATE orcamentos SET status = 'APROVADO', data_aprovacao = NOW(), congelado_em = COALESCE(congelado_em, NOW()),
      atualizado_em = date_trunc('milliseconds', clock_timestamp()) WHERE id = ${c.id}`);
    await tx.execute(sql`UPDATE clientes SET ultima_compra_em = NOW() WHERE id = ${c.clienteId}`);
    if (conferidas) await marcarMedicoesConferidas(tx, c.grupoId, u.id);
    await auditar(tx, c.id, u.id, [{ acao: 'STATUS', descricao: `Aprovado pelo cliente: virou o pedido ${numero}.`, detalhes: { de: c.status, para: 'APROVADO', pedidoId: p!.id } }]);
    await registrarEvento(tx, p!.id, u.id, 'CRIADO',
      `Pedido criado a partir do orçamento ${c.codigo} v${c.versao} (${STATUS_PEDIDO[status]}).${e.observacao ? ` ${e.observacao}` : ''}`,
      { orcamentoId: c.id, valor });
    // Financeiro: cobranças do cliente (sinal + saldo) e comissão do vendedor.
    await criarPlanoRecebimento(tx, p!.id, u.id);
    await sincronizarComissao(tx, p!.id, u.id);
    return { id: p!.id, numero, status };
  });
}

// ------------------------------------------------------------------ conferência de medidas e aditivos

/**
 * As medidas do pedido foram conferidas (sem alteração ou aditivo de medição confirmado):
 * as medições feitas do projeto (Agenda e medição) ficam marcadas como conferidas.
 */
export async function marcarMedicoesConferidas(tx: Exec, grupoId: string, usuarioId: string) {
  await tx.execute(sql`UPDATE medicoes SET conferida_em = NOW(), conferida_por_id = ${usuarioId}, atualizado_em = NOW()
    WHERE status = 'REALIZADA' AND conferida_em IS NULL
      AND orcamento_id IN (SELECT id FROM orcamentos WHERE grupo_id = ${grupoId})`);
}

/** Medição feita e nada mudou: segue para aguardar o sinal. `dia` = dia da conferência (feita sem internet). */
export async function conferirSemAlteracao(db: Banco, u: UsuarioSessao, pedidoId: string, dia = hojeLoja()) {
  await db.transaction(async (tx) => {
    const p = await pedidoDoUsuario(tx, u, pedidoId, true);
    if (p.status !== 'CONFERENCIA_MEDIDAS') throw new ErroPedido('O pedido não está em conferência de medidas.', 409);
    if (await rascunhoDoAditivo(tx, p)) throw new ErroPedido('Há um aditivo de medição em aberto: confirme ou descarte antes.', 409);
    await tx.execute(sql`UPDATE pedidos SET medidas_conferidas_em = NOW(), medidas_conferidas_por_id = ${u.id},
      data_previsao_entrega = ${await previsaoEntrega(tx, p, dia)}::date WHERE id = ${p.id}`);
    await mudarStatus(tx, p, 'AGUARDANDO_SINAL', u.id, 'Medidas conferidas no local, sem alteração.');
    await marcarMedicoesConferidas(tx, p.grupoId, u.id);
    await atualizarVencimentoSaldo(tx, p.id);
    await sincronizarComissao(tx, p.id, u.id);
  });
}

/**
 * Abre um aditivo: copia a versão que vale no pedido para um rascunho editável no configurador.
 * Na conferência de medidas é o aditivo de medição; depois, aditivo de alteração (12.4).
 */
export async function abrirAditivo(db: Banco, u: UsuarioSessao, pedidoId: string, motivo: string | null) {
  return db.transaction(async (tx) => {
    const p = await pedidoDoUsuario(tx, u, pedidoId, true);
    const tipo = p.status === 'CONFERENCIA_MEDIDAS' ? 'CONFERENCIA_MEDIDAS' : 'ALTERACAO';
    if (tipo === 'ALTERACAO' && !ETAPAS_ADITIVO.includes(p.status)) {
      throw new ErroPedido(`Pedido ${STATUS_PEDIDO[p.status]?.toLowerCase()}: não aceita aditivo.`, 409);
    }
    const aberto = await rascunhoDoAditivo(tx, p);
    if (aberto) return { orcamentoId: aberto.id, jaAberto: true };
    const vigente = (await lerCabecalho(tx, p.orcamentoId))!;
    await tx.execute(sql`SELECT id FROM orcamentos WHERE grupo_id = ${p.grupoId} FOR UPDATE`);
    const novoId = await criarVersao(tx, vigente, u, true);
    await tx.execute(sql`UPDATE orcamentos SET aditivo_pedido_id = ${p.id}, validade_ate = NULL,
      medidas_conferidas = ${tipo === 'CONFERENCIA_MEDIDAS' ? true : vigente.medidasConferidas},
      atualizado_em = date_trunc('milliseconds', clock_timestamp()) WHERE id = ${novoId}`);
    await recalcularTotais(tx, novoId);
    const [n] = await linhas<{ n: number }>(tx, sql`SELECT COALESCE(MAX(numero), 0)::int + 1 AS n FROM pedido_aditivos WHERE pedido_id = ${p.id}`);
    // O índice único parcial impede dois aditivos abertos ao mesmo tempo.
    await tx.execute(sql`
      INSERT INTO pedido_aditivos (pedido_id, numero, tipo, orcamento_anterior_id, orcamento_novo_id, valor_anterior, motivo, criado_por_id)
      VALUES (${p.id}, ${n!.n}, ${tipo}, ${p.orcamentoId}, ${novoId}, ${p.valorTotal}, ${motivo}, ${u.id})`);
    const rotulo = tipo === 'CONFERENCIA_MEDIDAS' ? 'de medição' : 'de alteração';
    await auditar(tx, novoId, u.id, [{ acao: 'NOVA_VERSAO', descricao: `Aditivo ${n!.n} ${rotulo} do pedido ${p.numero}, a partir da v${vigente.versao}.` }]);
    await registrarEvento(tx, p.id, u.id, 'ADITIVO_ABERTO', `Aditivo ${n!.n} ${rotulo} aberto${motivo ? `: ${motivo}` : ''}.`, { orcamentoId: novoId });
    return { orcamentoId: novoId, jaAberto: false };
  });
}

/** Descarta o aditivo em aberto (o rascunho nunca foi ao cliente e é apagado). */
export async function descartarAditivo(db: Banco, u: UsuarioSessao, pedidoId: string) {
  await db.transaction(async (tx) => {
    const p = await pedidoDoUsuario(tx, u, pedidoId, true);
    const [a] = await linhas<{ id: string; numero: number }>(tx, sql`
      SELECT id, numero FROM pedido_aditivos WHERE pedido_id = ${p.id} AND status = 'RASCUNHO'`);
    if (!a) throw new ErroPedido('Não há aditivo em aberto.', 409);
    const [vig] = await linhas<{ versao: number }>(tx, sql`SELECT versao FROM orcamentos WHERE id = ${p.orcamentoId}`);
    // Todas as versões rascunho criadas depois da vigente (o aditivo e eventuais conflitos), da mais nova para a mais velha.
    const rasc = await linhas<{ id: string }>(tx, sql`
      SELECT id FROM orcamentos WHERE grupo_id = ${p.grupoId} AND versao > ${vig!.versao} AND status = 'RASCUNHO' ORDER BY versao DESC`);
    await tx.execute(sql`UPDATE pedido_aditivos SET status = 'DESCARTADO', orcamento_novo_id = NULL WHERE id = ${a.id}`);
    for (const r of rasc) await tx.execute(sql`DELETE FROM orcamentos WHERE id = ${r.id}`);
    await registrarEvento(tx, p.id, u.id, 'ADITIVO_DESCARTADO', `Aditivo ${a.numero} descartado.`);
  });
}

export type ResultadoAditivo = { diferenca: string; valorNovo: string; ordensCriadas: string[]; avisos: string[] };

/**
 * Confirma o aditivo: a versão do rascunho passa a valer no pedido (APROVADO e congelada).
 * A trava de margem vale aqui também (mesma regra do envio da proposta).
 */
export async function confirmarAditivo(db: Banco, u: UsuarioSessao, pedidoId: string): Promise<ResultadoAditivo> {
  return db.transaction(async (tx) => {
    const p = await pedidoDoUsuario(tx, u, pedidoId, true);
    const [a] = await linhas<{ id: string; numero: number; tipo: string }>(tx, sql`
      SELECT id, numero, tipo FROM pedido_aditivos WHERE pedido_id = ${p.id} AND status = 'RASCUNHO'`);
    if (!a) throw new ErroPedido('Não há aditivo em aberto.', 409);
    const r = await rascunhoDoAditivo(tx, p);
    if (!r) throw new ErroPedido('O rascunho do aditivo não foi encontrado. Descarte e abra de novo.', 409);
    const c = (await lerCabecalho(tx, r.id))!;
    if (c.versaoMaisNovaId !== c.id) throw new ErroPedido('Há uma versão mais nova do aditivo: confira antes de confirmar.', 409);
    const [qtd] = await linhas<{ n: number }>(tx, sql`SELECT COUNT(*)::int AS n FROM orcamento_itens_compostos WHERE orcamento_id = ${c.id}`);
    if (!qtd?.n) throw new ErroPedido('O aditivo ficou sem itens. Para desistir da venda, cancele o pedido.', 409);
    const lib = situacaoLiberacao(c);
    if (lib.pendente) {
      if (u.perfil !== 'ADMIN') throw new ErroPedido('Precisa da senha do administrador para confirmar o aditivo.', 409, { exigeLiberacao: true, orcamentoId: c.id, motivos: lib.motivos });
      await tx.execute(sql`UPDATE orcamentos SET liberado_por_id = ${u.id}, liberado_em = NOW(),
        liberado_margem_pct = margem_prevista_pct, liberado_desconto_pct = desconto_percentual WHERE id = ${c.id}`);
    }

    const diferenca = d(c.total).minus(d(p.valorTotal));
    await tx.execute(sql`UPDATE orcamentos SET status = 'APROVADO', data_aprovacao = NOW(), congelado_em = NOW(),
      atualizado_em = date_trunc('milliseconds', clock_timestamp()) WHERE id = ${c.id}`);
    await tx.execute(sql`UPDATE pedidos SET orcamento_id = ${c.id}, valor_total_final = ${c.total}, atualizado_em = NOW() WHERE id = ${p.id}`);
    await tx.execute(sql`UPDATE pedido_aditivos SET status = 'CONFIRMADO', orcamento_novo_id = ${c.id}, valor_novo = ${c.total},
      diferenca = ${diferenca.toFixed(2)}, confirmado_por_id = ${u.id}, confirmado_em = NOW() WHERE id = ${a.id}`);
    const txtDif = diferenca.isZero() ? 'sem mudança de valor' : `diferença de ${diferenca.gt(0) ? '+' : '-'} R$ ${diferenca.abs().toFixed(2)}`;
    await auditar(tx, c.id, u.id, [{ acao: 'STATUS', descricao: `Aditivo ${a.numero} confirmado no pedido ${p.numero} (${txtDif}).` }]);
    await registrarEvento(tx, p.id, u.id, 'ADITIVO_CONFIRMADO',
      `Aditivo ${a.numero} confirmado: v${c.versao}, total R$ ${d(c.total).toFixed(2)} (${txtDif}).`,
      { aditivoId: a.id, de: p.valorTotal, para: c.total, diferenca: diferenca.toFixed(2) });

    const avisos: string[] = [];
    let ordensCriadas: string[] = [];
    if (a.tipo === 'CONFERENCIA_MEDIDAS' && p.status === 'CONFERENCIA_MEDIDAS') {
      await tx.execute(sql`UPDATE pedidos SET medidas_conferidas_em = NOW(), medidas_conferidas_por_id = ${u.id},
        data_previsao_entrega = ${await previsaoEntrega(tx, p)}::date WHERE id = ${p.id}`);
      await mudarStatus(tx, p, 'AGUARDANDO_SINAL', u.id, 'Medidas conferidas no local (com aditivo).');
      await marcarMedicoesConferidas(tx, p.grupoId, u.id);
    } else if (ETAPAS_COMPRA.includes(p.status)) {
      const g = await gerarCompras(tx, p.id, p.lojaId, a.id, a.numero);
      ordensCriadas = g.criadas;
      avisos.push(...g.reducoes.map((x) => `Já comprado a mais: ${x}. Combine com o fornecedor.`));
      if (g.criadas.length) avisos.push(`${g.criadas.length} ordem(ns) de compra complementar(es) criada(s).`);
      await recalcularStatus(tx, p.id, u.id);
    }
    await atualizarVencimentoSaldo(tx, p.id);
    avisos.push(...await ajustarPorAditivo(tx, p.id, diferenca, a.numero, u.id));
    await sincronizarPagarInstalacao(tx, p.id, u.id);
    await sincronizarComissao(tx, p.id, u.id);
    if (!diferenca.isZero()) {
      avisos.push(diferenca.gt(0)
        ? `O cliente passa a dever mais R$ ${diferenca.toFixed(2)}.`
        : `O valor do pedido caiu R$ ${diferenca.abs().toFixed(2)}: combine a devolução ou o abatimento com o cliente.`);
    }
    return { diferenca: diferenca.toFixed(2), valorNovo: c.total, ordensCriadas, avisos };
  });
}

// ------------------------------------------------------------------ sinal e compras

export type EntradaSinal = { valor: string; forma: string; recebidoEm: string; parcelas?: number; bandeira?: string | null } | { semSinal: true; motivo?: string };

/** Confirma o sinal (ou libera sem sinal) e gera as ordens de compra por fornecedor. */
export async function liberarCompras(db: Banco, u: UsuarioSessao, pedidoId: string, e: EntradaSinal) {
  return db.transaction(async (tx) => {
    const p = await pedidoDoUsuario(tx, u, pedidoId, true);
    if (p.status === 'CONFERENCIA_MEDIDAS') throw new ErroPedido('Confira as medidas no local antes de liberar as compras.', 409);
    if (p.status !== 'AGUARDANDO_SINAL') throw new ErroPedido('As compras deste pedido já foram liberadas.', 409);
    if (await rascunhoDoAditivo(tx, p)) throw new ErroPedido('Há um aditivo em aberto: confirme ou descarte antes de liberar as compras.', 409);
    if ('semSinal' in e) {
      await tx.execute(sql`UPDATE pedidos SET liberado_sem_sinal = TRUE, compras_liberadas_em = NOW(), compras_liberadas_por_id = ${u.id} WHERE id = ${p.id}`);
      await registrarEvento(tx, p.id, u.id, 'COMPRAS_LIBERADAS', `Compras liberadas sem sinal pelo administrador${e.motivo ? `: ${e.motivo}` : ''}.`);
    } else {
      if (d(e.valor).gt(d(p.valorTotal))) throw new ErroPedido('O sinal não pode ser maior que o valor do pedido.');
      await tx.execute(sql`UPDATE pedidos SET sinal_valor = ${d(e.valor).toFixed(2)}, sinal_forma = ${e.forma}::forma_pagamento_enum,
        sinal_recebido_em = ${e.recebidoEm}::date, compras_liberadas_em = NOW(), compras_liberadas_por_id = ${u.id} WHERE id = ${p.id}`);
      // Baixa nas contas a receber (sinal primeiro; o que passar abate o saldo).
      await criarPlanoRecebimento(tx, p.id, u.id);
      try {
        const r = await receberDoCliente(tx, p.id, { valor: e.valor, forma: e.forma, parcelas: e.parcelas, data: e.recebidoEm, bandeira: e.bandeira }, u.id);
        const naMaquina = r.cobrado !== d(e.valor).toFixed(2) ? ` (passou R$ ${r.cobrado} na maquininha)` : '';
        await registrarEvento(tx, p.id, u.id, 'SINAL', `Sinal de R$ ${d(e.valor).toFixed(2)}${naMaquina} recebido em ${e.recebidoEm.split('-').reverse().join('/')}.`,
          { valor: e.valor, forma: e.forma });
      } catch (x) {
        if (x instanceof ErroFinanceiro) throw new ErroPedido(x.message, x.status);
        throw x;
      }
    }
    await mudarStatus(tx, p, 'EM_COMPRA', u.id);
    const g = await gerarCompras(tx, p.id, p.lojaId, null, null);
    await recalcularStatus(tx, p.id, u.id);
    return { ordensCriadas: g.criadas };
  });
}

type ComponenteCompra = {
  itemId: string; ambiente: string; produtoId: string | null; sku: string; descricao: string; unidade: string;
  quantidade: string; custoUnitario: string; fornecedorId: string | null;
};

/**
 * Explode os componentes da versão vigente por fornecedor (seção 9 etapa 4).
 * Primeira vez: uma linha por componente de cada item. Depois de um aditivo: só o que falta
 * (precisa - já pedido em ordens não canceladas), numa ordem complementar por fornecedor.
 */
export async function gerarCompras(tx: Exec, pedidoId: string, lojaId: string, aditivoId: string | null, aditivoNumero: number | null) {
  const comps = await linhas<ComponenteCompra>(tx, sql`
    SELECT oc.item_composto_id AS "itemId", i.ambiente, oc.produto_id AS "produtoId", oc.sku_snapshot AS sku,
           oc.descricao_snapshot AS descricao, oc.unidade_medida_snapshot AS unidade, oc.quantidade_final::text AS quantidade,
           oc.custo_unitario_snapshot::text AS "custoUnitario", COALESCE(pr.fornecedor_padrao_id, oc.fornecedor_id) AS "fornecedorId"
      FROM pedidos p
      JOIN orcamento_itens_compostos i ON i.orcamento_id = p.orcamento_id
      JOIN orcamento_componentes oc ON oc.item_composto_id = i.id
      LEFT JOIN produtos pr ON pr.id = oc.produto_id
     WHERE p.id = ${pedidoId} AND COALESCE(pr.categoria_id, 0) <> ${CATEGORIA_INSTALACAO}
     ORDER BY i.ordem, oc.ordem`);

  type Linha = Omit<ComponenteCompra, 'itemId' | 'fornecedorId'> & { itemId: string | null };
  const porFornecedor = new Map<string, Linha[]>();
  const add = (forn: string | null, l: Linha) => {
    const k = forn ?? '';
    porFornecedor.set(k, [...(porFornecedor.get(k) ?? []), l]);
  };
  const reducoes: string[] = [];

  const jaPedidas = await linhas<{ sku: string; quantidade: string; unidade: string }>(tx, sql`
    SELECT it.sku, SUM(it.quantidade)::text AS quantidade, MIN(it.unidade::text) AS unidade
      FROM ordem_compra_itens it JOIN ordens_compra o ON o.id = it.ordem_id
     WHERE o.pedido_id = ${pedidoId} AND o.status <> 'CANCELADA' GROUP BY it.sku`);

  if (jaPedidas.length === 0) {
    for (const c of comps) add(c.fornecedorId, { ...c });
  } else {
    const precisa = new Map<string, { q: ReturnType<typeof d>; c: ComponenteCompra }>();
    for (const c of comps) {
      const x = precisa.get(c.sku);
      precisa.set(c.sku, { q: (x?.q ?? d(0)).plus(d(c.quantidade)), c: x?.c ?? c });
    }
    const ja = new Map(jaPedidas.map((j) => [j.sku, j]));
    for (const [sku, { q, c }] of precisa) {
      const dif = q.minus(d(ja.get(sku)?.quantidade ?? 0));
      if (dif.gt(0)) add(c.fornecedorId, { ...c, itemId: null, ambiente: `Complemento do aditivo ${aditivoNumero ?? ''}`.trim(), quantidade: dif.toFixed(4) });
      else if (dif.lt(0)) reducoes.push(`${sku} ${dif.abs().toFixed(2)} ${c.unidade}`);
    }
    for (const j of jaPedidas) {
      if (!precisa.has(j.sku)) reducoes.push(`${j.sku} ${d(j.quantidade).toFixed(2)} ${j.unidade} (saiu do pedido)`);
    }
  }

  const criadas: string[] = [];
  const hoje = hojeLoja();
  for (const [forn, itens] of porFornecedor) {
    const [f] = forn ? await linhas<{ categoria: string; prazo: number | null }>(tx, sql`
      SELECT categoria, prazo_entrega_dias AS prazo FROM fornecedores WHERE id = ${forn}`) : [];
    const tipo = f?.categoria === 'COSTUREIRA' ? 'COSTURA' : f?.categoria === 'PERSIANA' ? 'FABRICA' : 'COMPRA';
    const [n] = await linhas<{ n: string }>(tx, sql`SELECT nextval('ordem_compra_numero_seq')::text AS n`);
    const numero = `OC-${hoje.slice(0, 4)}-${n!.n.padStart(4, '0')}`;
    const totais = itens.map((i) => dinheiro(d(i.quantidade).mul(d(i.custoUnitario))));
    const total = totais.reduce((s, x) => s.plus(x), d(0));
    // Prazo do fornecedor em dias úteis [suposição: o cadastro não diz se são corridos ou úteis].
    const previsao = f?.prazo != null ? somarDiasUteis(hoje, f.prazo) : null;
    const [oc] = await linhas<{ id: string }>(tx, sql`
      INSERT INTO ordens_compra (loja_id, numero, pedido_id, aditivo_id, fornecedor_id, tipo, custo_previsto, previsao_entrega)
      VALUES (${lojaId}, ${numero}, ${pedidoId}, ${aditivoId}, ${forn || null}, ${tipo}, ${total.toFixed(2)}, ${previsao}::date)
      RETURNING id`);
    const valores = itens.map((i, k) => sql`(${oc!.id}, ${i.itemId}, ${i.ambiente}, ${i.produtoId}, ${i.sku}, ${i.descricao},
      ${i.unidade}::unidade_medida_enum, ${d(i.quantidade).toFixed(4)}, ${d(i.custoUnitario).toFixed(4)}, ${totais[k]!.toFixed(2)}, ${k + 1})`);
    await tx.execute(sql`INSERT INTO ordem_compra_itens (ordem_id, item_composto_id, ambiente, produto_id, sku, descricao, unidade,
      quantidade, custo_unitario, custo_total, ordem) VALUES ${sql.join(valores, sql`, `)}`);
    await sincronizarPagarOrdem(tx, oc!.id); // previsão do custo em Contas a pagar
    criadas.push(numero);
  }
  if (criadas.length) {
    await registrarEvento(tx, pedidoId, null, 'COMPRAS_GERADAS', `Ordens de compra geradas: ${criadas.join(', ')}.`, { ordens: criadas });
  }
  return { criadas, reducoes };
}

/**
 * O status do pedido acompanha as ordens de compra:
 * alguma aberta -> EM_COMPRA; todas enviadas -> EM_PRODUCAO; todas recebidas -> PRONTO_ESTOQUE
 * (ou INSTALACAO_AGENDADA, se a instalação já foi pré-agendada).
 */
export async function recalcularStatus(tx: Exec, pedidoId: string, usuarioId: string | null) {
  const [p] = await linhas<{ id: string; status: string; agendado: boolean }>(tx, sql`
    SELECT id, status_operacional AS status, data_instalacao_agendada IS NOT NULL AS agendado FROM pedidos WHERE id = ${pedidoId}`);
  if (!p || !ETAPAS_COMPRA.includes(p.status)) return;
  const [r] = await linhas<{ total: number; enviadas: number; recebidas: number; custoReal: string }>(tx, sql`
    SELECT COUNT(*) FILTER (WHERE status <> 'CANCELADA')::int AS total,
           COUNT(*) FILTER (WHERE status IN ('ENVIADA', 'RECEBIDA'))::int AS enviadas,
           COUNT(*) FILTER (WHERE status = 'RECEBIDA')::int AS recebidas,
           COALESCE(SUM(COALESCE(custo_real, custo_previsto)) FILTER (WHERE status = 'RECEBIDA'), 0)::text AS "custoReal"
      FROM ordens_compra WHERE pedido_id = ${pedidoId}`);
  const pronto = p.agendado ? 'INSTALACAO_AGENDADA' : 'PRONTO_ESTOQUE';
  const alvo = r!.total === r!.recebidas ? pronto : r!.total === r!.enviadas ? 'EM_PRODUCAO' : 'EM_COMPRA';
  await tx.execute(sql`UPDATE pedidos SET custo_real_consolidado = ${r!.custoReal} WHERE id = ${pedidoId}`);
  await mudarStatus(tx, p, alvo, usuarioId, alvo === pronto ? 'Todas as compras e a produção foram recebidas.' : '');
}

export type AcaoOrdem = {
  acao: 'ENVIAR' | 'RECEBER' | 'CANCELAR' | 'REABRIR' | 'EDITAR';
  fornecedorId?: string | null; previsaoEntrega?: string | null; custoReal?: string | null; observacoes?: string | null;
};

export async function atualizarOrdem(db: Banco, u: UsuarioSessao, ordemId: string, e: AcaoOrdem) {
  return db.transaction(async (tx) => {
    const [o] = await linhas<{ id: string; numero: string; status: string; pedidoId: string; fornecedorId: string | null; lojaId: string; pedidoStatus: string }>(tx, sql`
      SELECT o.id, o.numero, o.status, o.pedido_id AS "pedidoId", o.fornecedor_id AS "fornecedorId", o.loja_id AS "lojaId",
             p.status_operacional AS "pedidoStatus"
        FROM ordens_compra o JOIN pedidos p ON p.id = o.pedido_id WHERE o.id = ${ordemId} FOR UPDATE OF o`);
    if (!o || o.lojaId !== u.lojaId) throw new ErroPedido('Ordem de compra não encontrada.', 404);
    if (['CANCELADO', 'INSTALADO_CONCLUIDO'].includes(o.pedidoStatus) && e.acao !== 'EDITAR') {
      throw new ErroPedido('O pedido já foi encerrado.', 409);
    }
    const de = o.status;
    let para = o.status;
    if (e.fornecedorId !== undefined) {
      if (o.status !== 'ABERTA') throw new ErroPedido('Só dá para trocar o fornecedor antes de enviar a ordem.', 409);
      if (e.fornecedorId) {
        const [f] = await linhas<{ categoria: string }>(tx, sql`SELECT categoria FROM fornecedores WHERE id = ${e.fornecedorId} AND ativo`);
        if (!f) throw new ErroPedido('Fornecedor não encontrado.');
        const tipo = f.categoria === 'COSTUREIRA' ? 'COSTURA' : f.categoria === 'PERSIANA' ? 'FABRICA' : 'COMPRA';
        await tx.execute(sql`UPDATE ordens_compra SET fornecedor_id = ${e.fornecedorId}, tipo = ${tipo} WHERE id = ${o.id}`);
      } else {
        await tx.execute(sql`UPDATE ordens_compra SET fornecedor_id = NULL, tipo = 'COMPRA' WHERE id = ${o.id}`);
      }
      o.fornecedorId = e.fornecedorId;
    }
    if (e.previsaoEntrega !== undefined) await tx.execute(sql`UPDATE ordens_compra SET previsao_entrega = ${e.previsaoEntrega}::date WHERE id = ${o.id}`);
    if (e.observacoes !== undefined) await tx.execute(sql`UPDATE ordens_compra SET observacoes = ${e.observacoes} WHERE id = ${o.id}`);

    if (e.acao === 'ENVIAR') {
      if (o.status !== 'ABERTA') throw new ErroPedido('Só ordem aberta pode ser enviada.', 409);
      if (!o.fornecedorId) throw new ErroPedido('Escolha o fornecedor antes de enviar.', 409);
      para = 'ENVIADA';
      await tx.execute(sql`UPDATE ordens_compra SET status = 'ENVIADA', enviada_em = NOW() WHERE id = ${o.id}`);
    } else if (e.acao === 'RECEBER') {
      if (!['ABERTA', 'ENVIADA'].includes(o.status)) throw new ErroPedido('Esta ordem não está aguardando entrega.', 409);
      para = 'RECEBIDA';
      await tx.execute(sql`UPDATE ordens_compra SET status = 'RECEBIDA', recebida_em = NOW(), enviada_em = COALESCE(enviada_em, NOW()),
        custo_real = COALESCE(${e.custoReal ?? null}::numeric, custo_previsto) WHERE id = ${o.id}`);
    } else if (e.acao === 'CANCELAR') {
      if (!['ABERTA', 'ENVIADA'].includes(o.status)) throw new ErroPedido('Esta ordem não pode ser cancelada.', 409);
      para = 'CANCELADA';
      await tx.execute(sql`UPDATE ordens_compra SET status = 'CANCELADA' WHERE id = ${o.id}`);
    } else if (e.acao === 'REABRIR') {
      if (!['RECEBIDA', 'CANCELADA', 'ENVIADA'].includes(o.status)) throw new ErroPedido('Esta ordem já está aberta.', 409);
      para = o.status === 'RECEBIDA' ? 'ENVIADA' : 'ABERTA';
      await tx.execute(sql`UPDATE ordens_compra SET status = ${para}, recebida_em = NULL,
        enviada_em = CASE WHEN ${para} = 'ABERTA' THEN NULL ELSE enviada_em END WHERE id = ${o.id}`);
    } else if (e.custoReal !== undefined) {
      await tx.execute(sql`UPDATE ordens_compra SET custo_real = ${e.custoReal}::numeric WHERE id = ${o.id}`);
    }
    await tx.execute(sql`UPDATE ordens_compra SET atualizado_em = NOW() WHERE id = ${o.id}`);
    if (para !== de) {
      const nomes: Record<string, string> = { ENVIADA: 'enviada ao fornecedor', RECEBIDA: 'recebida', CANCELADA: 'cancelada', ABERTA: 'reaberta' };
      await registrarEvento(tx, o.pedidoId, u.id, 'ORDEM_COMPRA', `${o.numero} ${nomes[para] ?? para}.`, { ordemId: o.id, de, para });
    }
    await recalcularStatus(tx, o.pedidoId, u.id);
    await sincronizarPagarOrdem(tx, o.id, u.id);
    return { pedidoId: o.pedidoId };
  });
}

// ------------------------------------------------------------------ instalação

export type EntradaAgenda = { data: string; instaladorId: string; duracaoHoras?: string | null; observacoes?: string | null };

/** Agenda (ou reagenda) a instalação. Antes de ficar pronto vale como pré-agendamento. */
export async function agendarInstalacao(db: Banco, u: UsuarioSessao, pedidoId: string, e: EntradaAgenda) {
  await db.transaction(async (tx) => {
    const p = await pedidoDoUsuario(tx, u, pedidoId, true);
    if (!ETAPAS_AGENDA.includes(p.status)) {
      throw new ErroPedido(p.status === 'INSTALADO_CONCLUIDO' ? 'Pedido já instalado.' : 'Libere as compras antes de agendar a instalação.', 409);
    }
    const [f] = await linhas<{ nome: string; categoria: string }>(tx, sql`
      SELECT nome_fantasia AS nome, categoria FROM fornecedores WHERE id = ${e.instaladorId} AND ativo`);
    if (!f) throw new ErroPedido('Instalador não encontrado.');
    if (f.categoria !== 'INSTALADOR') throw new ErroPedido(`${f.nome} não está cadastrado como instalador.`);
    await tx.execute(sql`UPDATE pedidos SET data_instalacao_agendada = ${e.data}::timestamptz, instalador_fornecedor_id = ${e.instaladorId},
      instalacao_duracao_horas = ${e.duracaoHoras ?? null}::numeric, obs_instalacao = COALESCE(${e.observacoes ?? null}, obs_instalacao),
      instalacao_agendada_por_id = ${u.id}, atualizado_em = NOW() WHERE id = ${p.id}`);
    const quando = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(e.data));
    const re = p.instalacaoAgendada ? 'reagendada' : 'agendada';
    await registrarEvento(tx, p.id, u.id, 'AGENDA', `Instalação ${re} para ${quando} com ${f.nome}${p.status === 'PRONTO_ESTOQUE' || p.status === 'INSTALACAO_AGENDADA' ? '' : ' (pré-agendada: ainda em produção)'}.`,
      { data: e.data, instaladorId: e.instaladorId });
    if (p.status === 'PRONTO_ESTOQUE') await mudarStatus(tx, p, 'INSTALACAO_AGENDADA', u.id);
    await sincronizarPagarInstalacao(tx, p.id, u.id);
    await atualizarVencimentoSaldo(tx, p.id);
  });
}

export async function desmarcarInstalacao(db: Banco, u: UsuarioSessao, pedidoId: string) {
  await db.transaction(async (tx) => {
    const p = await pedidoDoUsuario(tx, u, pedidoId, true);
    if (!p.instalacaoAgendada || p.status === 'INSTALADO_CONCLUIDO') throw new ErroPedido('Não há instalação agendada.', 409);
    await tx.execute(sql`UPDATE pedidos SET data_instalacao_agendada = NULL, atualizado_em = NOW() WHERE id = ${p.id}`);
    await registrarEvento(tx, p.id, u.id, 'AGENDA', 'Instalação desmarcada.');
    if (p.status === 'INSTALACAO_AGENDADA') await mudarStatus(tx, p, 'PRONTO_ESTOQUE', u.id);
    await atualizarVencimentoSaldo(tx, p.id);
  });
}

export type EntradaAceite = {
  id: string; nomeRecebedor: string; documentoRecebedor?: string | null; assinaturaPng: string;
  checklist: { itemId?: string | null; descricao: string; ok: boolean }[];
  observacoes?: string | null; assinadoEm: string; offline?: boolean;
};

const ASSINATURA_MAX_BYTES = 400 * 1024;

export function decodificarAssinatura(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) throw new ErroPedido('Assinatura inválida (esperado PNG).');
  const b = Buffer.from(m[1]!, 'base64');
  if (b.length > ASSINATURA_MAX_BYTES) throw new ErroPedido('Assinatura grande demais.');
  if (b.length < 100 || b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new ErroPedido('Assinatura inválida (esperado PNG).');
  return b;
}

/**
 * Aceite digital do cliente na obra (feito no aparelho, até sem internet). O id vem do aparelho:
 * reenviar o mesmo aceite não duplica. Conclui o pedido e grava a data da instalação no cliente.
 */
export async function registrarAceite(db: Banco, u: UsuarioSessao, pedidoId: string, e: EntradaAceite) {
  const png = decodificarAssinatura(e.assinaturaPng);
  return db.transaction(async (tx) => {
    const [ja] = await linhas<{ pedidoId: string }>(tx, sql`SELECT pedido_id AS "pedidoId" FROM pedido_aceites WHERE id = ${e.id}`);
    if (ja) {
      if (ja.pedidoId !== pedidoId) throw new ErroPedido('Identificador de aceite repetido.', 409);
      return { repetido: true, avisos: [] as string[] };
    }
    const p = await pedidoDoUsuario(tx, u, pedidoId, true);
    if (p.status === 'INSTALADO_CONCLUIDO') throw new ErroPedido('Este pedido já tem o aceite do cliente.', 409);
    if (!ETAPAS_COMPRA.includes(p.status)) throw new ErroPedido(`Pedido ${STATUS_PEDIDO[p.status]?.toLowerCase()}: não dá para registrar a instalação.`, 409);
    const ressalvas = e.checklist.some((c) => !c.ok);
    await tx.execute(sql`
      INSERT INTO pedido_aceites (id, pedido_id, nome_recebedor, documento_recebedor, assinatura_png, checklist, observacoes, ressalvas,
        assinado_em, usuario_id, offline)
      VALUES (${e.id}, ${p.id}, ${e.nomeRecebedor}, ${e.documentoRecebedor ?? null}, ${png}, ${JSON.stringify(e.checklist)}::jsonb,
        ${e.observacoes ?? null}, ${ressalvas}, ${e.assinadoEm}::timestamptz, ${u.id}, ${e.offline ?? false})`);
    await tx.execute(sql`UPDATE pedidos SET data_instalacao_realizada = ${e.assinadoEm}::timestamptz,
      checklist_instalacao = ${JSON.stringify(e.checklist)}::jsonb,
      obs_instalacao = CASE WHEN ${e.observacoes ?? null}::text IS NULL THEN obs_instalacao ELSE ${e.observacoes ?? null} END,
      termo_aceite_assinatura_url = ${`/api/pedidos/${p.id}/termo-aceite.pdf`}, atualizado_em = NOW() WHERE id = ${p.id}`);
    await tx.execute(sql`UPDATE clientes SET ultima_instalacao_em = GREATEST(COALESCE(ultima_instalacao_em, ${e.assinadoEm}::timestamptz), ${e.assinadoEm}::timestamptz)
      WHERE id = ${p.clienteId}`);
    await registrarEvento(tx, p.id, u.id, 'ACEITE',
      `Cliente assinou o aceite (${e.nomeRecebedor})${ressalvas ? ' com ressalvas' : ''}${e.offline ? ', feito sem internet' : ''}.`, {}, e.offline ?? false);
    await mudarStatus(tx, p, 'INSTALADO_CONCLUIDO', u.id);

    await sincronizarPagarInstalacao(tx, p.id, u.id);
    // Pós-venda: ligar para o cliente alguns dias depois (spec: +7 dias).
    const diasPos = Number((await parametro(tx as Banco, p.lojaId, 'POS_VENDA_DIAS')) ?? 7);
    await tx.execute(sql`INSERT INTO pos_venda (loja_id, pedido_id, data_prevista)
      VALUES (${p.lojaId}, ${p.id}, ${somarDias(hojeLoja(), diasPos)}::date) ON CONFLICT (pedido_id) DO NOTHING`);

    const avisos: string[] = [];
    const saldo = await saldoDoCliente(tx, p);
    if (saldo.gt(0)) avisos.push(`Saldo a receber do cliente: R$ ${saldo.toFixed(2)}.`);
    if (ressalvas) avisos.push('Há itens marcados como não conferidos: veja as observações.');
    if (p.status !== 'INSTALACAO_AGENDADA') avisos.push('A instalação foi registrada antes de todas as compras serem recebidas.');
    if (avisos.length) await registrarEvento(tx, p.id, null, 'POS_VENDA', avisos.join(' '));
    return { repetido: false, avisos };
  });
}

// ------------------------------------------------------------------ cancelamento e nota fiscal

export async function cancelarPedido(db: Banco, u: UsuarioSessao, pedidoId: string, motivo: string) {
  await db.transaction(async (tx) => {
    const p = await pedidoDoUsuario(tx, u, pedidoId, true);
    if (['CANCELADO', 'INSTALADO_CONCLUIDO'].includes(p.status)) throw new ErroPedido('Este pedido já foi encerrado.', 409);
    const aberto = await rascunhoDoAditivo(tx, p);
    if (aberto) {
      await tx.execute(sql`UPDATE pedido_aditivos SET status = 'DESCARTADO', orcamento_novo_id = NULL WHERE pedido_id = ${p.id} AND status = 'RASCUNHO'`);
      const [vig] = await linhas<{ versao: number }>(tx, sql`SELECT versao FROM orcamentos WHERE id = ${p.orcamentoId}`);
      await tx.execute(sql`DELETE FROM orcamentos WHERE grupo_id = ${p.grupoId} AND versao > ${vig!.versao} AND status = 'RASCUNHO'`);
    }
    const ocs = await linhas<{ id: string; numero: string; status: string }>(tx, sql`
      UPDATE ordens_compra SET status = 'CANCELADA', atualizado_em = NOW()
       WHERE pedido_id = ${p.id} AND status = 'ABERTA' RETURNING id, numero, status`);
    for (const o of ocs) await sincronizarPagarOrdem(tx, o.id, u.id);
    const enviadas = await linhas<{ numero: string }>(tx, sql`SELECT numero FROM ordens_compra WHERE pedido_id = ${p.id} AND status IN ('ENVIADA', 'RECEBIDA')`);
    await tx.execute(sql`UPDATE pedidos SET cancelado_em = NOW(), motivo_cancelamento = ${motivo} WHERE id = ${p.id}`);
    await mudarStatus(tx, p, 'CANCELADO', u.id, `Motivo: ${motivo}.`);
    if (ocs.length) await registrarEvento(tx, p.id, u.id, 'ORDEM_COMPRA', `Ordens abertas canceladas: ${ocs.map((o) => o.numero).join(', ')}.`);
    if (enviadas.length) await registrarEvento(tx, p.id, null, 'AVISO', `Ordens já enviadas ou recebidas (resolver com o fornecedor): ${enviadas.map((o) => o.numero).join(', ')}.`);
    const pago = await cancelarFinanceiroPedido(tx, p.id);
    if (pago.gt(0)) {
      await registrarEvento(tx, p.id, null, 'AVISO', `O cliente já tinha pago R$ ${pago.toFixed(2)}. Se for devolver, lance em Financeiro > A pagar.`);
    }
  });
}

export type EntradaNota = { nfeNumero?: string | null; nfeChave?: string | null; nfseNumero?: string | null };

export async function registrarNota(db: Banco, u: UsuarioSessao, pedidoId: string, e: EntradaNota) {
  await db.transaction(async (tx) => {
    const p = await pedidoDoUsuario(tx, u, pedidoId, true);
    await tx.execute(sql`UPDATE pedidos SET nfe_numero = ${e.nfeNumero ?? null}, nfe_chave = ${e.nfeChave ?? null}, nfse_numero = ${e.nfseNumero ?? null},
      nf_registrada_em = CASE WHEN ${e.nfeNumero ?? e.nfseNumero ?? null}::text IS NULL THEN NULL ELSE NOW() END, atualizado_em = NOW() WHERE id = ${p.id}`);
    const partes = [e.nfeNumero ? `NF-e ${e.nfeNumero}` : null, e.nfseNumero ? `NFS-e ${e.nfseNumero}` : null].filter(Boolean);
    await registrarEvento(tx, p.id, u.id, 'NOTA_FISCAL', partes.length ? `Nota registrada: ${partes.join(' e ')}.` : 'Registro da nota apagado.');
  });
}

// ------------------------------------------------------------------ resposta da API

/** Ações que este usuário pode fazer agora (a tela mostra só os botões que valem). */
function acoesPossiveis(u: UsuarioSessao, p: CabecalhoPedido, aditivoAberto: boolean, temAceite: boolean): string[] {
  const a: string[] = [];
  const admin = (perm: Parameters<typeof pode>[1]) => pode(u, perm);
  if (p.status === 'CONFERENCIA_MEDIDAS' && !aditivoAberto) a.push('CONFERIR_SEM_ALTERACAO');
  if ((p.status === 'CONFERENCIA_MEDIDAS' || ETAPAS_ADITIVO.includes(p.status)) && !aditivoAberto) a.push('ABRIR_ADITIVO');
  if (aditivoAberto) a.push('CONFIRMAR_ADITIVO', 'DESCARTAR_ADITIVO');
  if (p.status === 'AGUARDANDO_SINAL' && !aditivoAberto && admin('financeiro.gerenciar')) a.push('REGISTRAR_SINAL', 'LIBERAR_SEM_SINAL');
  if (ETAPAS_AGENDA.includes(p.status) && admin('instalacao.gerenciar')) a.push('AGENDAR');
  if (p.instalacaoAgendada && p.status !== 'INSTALADO_CONCLUIDO' && admin('instalacao.gerenciar')) a.push('DESMARCAR');
  if (ETAPAS_COMPRA.includes(p.status) && !temAceite) a.push('ACEITE');
  if (!['CANCELADO', 'INSTALADO_CONCLUIDO'].includes(p.status) && admin('pedidos.todos')) a.push('CANCELAR');
  if (p.status !== 'CANCELADO' && admin('financeiro.gerenciar')) a.push('REGISTRAR_NF');
  return a;
}

/** O que o cliente ainda deve: cobranças em aberto (pedido antigo sem cobranças: total - sinal). */
async function saldoDoCliente(db: Exec, p: Pick<CabecalhoPedido, 'id' | 'valorTotal' | 'sinalValor' | 'status'>) {
  const s = await situacaoCliente(db, p.id);
  if (s.temPlano || p.status === 'CANCELADO') return d(s.aberto);
  return d(p.valorTotal).minus(d(p.sinalValor ?? 0));
}

/** Contas a receber, a pagar e lucro real do pedido (só ADMIN). */
async function financeiroDoPedido(db: Banco, p: CabecalhoPedido) {
  const lancamentos = await linhas(db, sql`
    SELECT l.id, l.tipo, l.origem, l.descricao, l.forma_pagamento AS forma, l.valor_bruto AS valor, l.taxa_transacao AS taxa,
           l.valor_liquido AS liquido, to_char(l.data_vencimento, 'YYYY-MM-DD') AS vencimento,
           to_char(l.data_liquidacao, 'YYYY-MM-DD') AS liquidacao, l.status, l.cartao, l.numero_parcela AS parcela,
           l.total_parcelas AS "totalParcelas", f.nome_fantasia AS fornecedor,
           (l.status = 'PREVISTO' AND l.data_vencimento < ${hojeLoja()}::date) AS vencido
      FROM lancamentos_financeiros l LEFT JOIN fornecedores f ON f.id = l.fornecedor_id
     WHERE l.pedido_id = ${p.id} AND l.status <> 'CANCELADO'
     ORDER BY l.tipo DESC, l.data_vencimento, l.criado_em`);
  const [lucro] = await lucroPedidos(db, [p.id], p.lojaId);
  return { lancamentos, lucro: lucro ?? null };
}

export async function montarPedido(db: Banco, u: UsuarioSessao, id: string) {
  const p = await lerPedido(db, id);
  if (!p || !pedidoNoEscopo(u, p)) return null;
  const verCusto = pode(u, 'custos.ver');
  const doc = (await lerDocumento(db, p.orcamentoId))!;
  const aditivos = await lerAditivos(db, p.id);
  const rasc = await rascunhoDoAditivo(db, p);
  const aberto = aditivos.find((a) => a.status === 'RASCUNHO');
  const [aceite] = await linhas<{ nomeRecebedor: string; documentoRecebedor: string | null; assinadoEm: string; ressalvas: boolean; observacoes: string | null; offline: boolean }>(db, sql`
    SELECT nome_recebedor AS "nomeRecebedor", documento_recebedor AS "documentoRecebedor", assinado_em AS "assinadoEm", ressalvas,
           observacoes, offline FROM pedido_aceites WHERE pedido_id = ${p.id}`);
  const compras = pode(u, 'compras.gerenciar') ? await listarOrdens(db, u.lojaId, { pedidoId: p.id }) : [];
  const eventos = await linhas(db, sql`
    SELECT e.id, e.acao, e.descricao, e.offline, e.criado_em AS "criadoEm", us.nome AS usuario
      FROM pedido_eventos e LEFT JOIN usuarios us ON us.id = e.usuario_id
     WHERE e.pedido_id = ${p.id} ORDER BY e.criado_em DESC, e.id LIMIT 300`);
  const saldo = await saldoDoCliente(db, p);
  const fin = pode(u, 'financeiro.gerenciar') ? await financeiroDoPedido(db, p) : null;
  const { custoPrevisto, custoReal, ...semCusto } = p;
  return {
    ...semCusto,
    ...(verCusto ? { custoPrevisto, custoReal } : {}),
    statusNome: STATUS_PEDIDO[p.status] ?? p.status,
    saldo: saldo.toFixed(2),
    itens: doc.itens.map((i) => ({
      id: i.id, ambiente: i.ambiente, tipo: i.tipo, descricaoComercial: i.descricaoComercial,
      larguraProducao: i.larguraProducao, alturaProducao: i.alturaProducao, vendaTotal: i.vendaTotal,
      alertas: i.alertas, especificacaoTecnica: i.especificacaoTecnica,
    })),
    aditivos,
    aditivoAberto: aberto ? { ...aberto, orcamentoId: rasc?.id ?? aberto.orcamentoNovoId } : null,
    compras,
    aceite: aceite ?? null,
    eventos,
    acoes: acoesPossiveis(u, p, Boolean(aberto), Boolean(aceite)),
    financeiro: fin,
  };
}

export async function listarOrdens(db: Exec, lojaId: string, f: { pedidoId?: string; status?: string; fornecedorId?: string }) {
  const ordens = await linhas<{ id: string }>(db, sql`
    SELECT o.id, o.numero, o.pedido_id AS "pedidoId", p.numero_pedido AS "pedidoNumero", c.nome_completo AS "clienteNome",
           o.fornecedor_id AS "fornecedorId", f.nome_fantasia AS "fornecedorNome", f.categoria AS "fornecedorCategoria",
           f.whatsapp AS "fornecedorWhatsapp", o.tipo, o.status, o.custo_previsto AS "custoPrevisto", o.custo_real AS "custoReal",
           to_char(o.previsao_entrega, 'YYYY-MM-DD') AS "previsaoEntrega", o.observacoes, o.criado_em AS "criadoEm",
           o.enviada_em AS "enviadaEm", o.recebida_em AS "recebidaEm", a.numero AS "aditivoNumero",
           (o.status IN ('ABERTA', 'ENVIADA') AND o.previsao_entrega < CURRENT_DATE) AS atrasada,
           COALESCE((SELECT json_agg(json_build_object('sku', it.sku, 'descricao', it.descricao, 'unidade', it.unidade,
               'quantidade', it.quantidade, 'ambiente', it.ambiente, 'custoTotal', it.custo_total) ORDER BY it.ordem)
             FROM ordem_compra_itens it WHERE it.ordem_id = o.id), '[]'::json) AS itens
      FROM ordens_compra o
      JOIN pedidos p ON p.id = o.pedido_id
      JOIN clientes c ON c.id = p.cliente_id
      LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
      LEFT JOIN pedido_aditivos a ON a.id = o.aditivo_id
     WHERE o.loja_id = ${lojaId}
       AND (${f.pedidoId ?? null}::uuid IS NULL OR o.pedido_id = ${f.pedidoId ?? null})
       AND (${f.status ?? null}::text IS NULL OR o.status = ${f.status ?? null})
       AND (${f.fornecedorId ?? null}::uuid IS NULL OR o.fornecedor_id = ${f.fornecedorId ?? null})
     ORDER BY CASE o.status WHEN 'ABERTA' THEN 0 WHEN 'ENVIADA' THEN 1 WHEN 'RECEBIDA' THEN 2 ELSE 3 END, o.criado_em DESC
     LIMIT 300`);
  return ordens;
}
