import { sql, type SQL } from 'drizzle-orm';
import { d } from '@sistema/motor-calculo';
import type { Banco } from '../db/conexao.js';
import type { UsuarioSessao } from '../auth/sessao.js';
import { pode } from '../auth/permissoes.js';
import { auditar, lerCabecalho, noEscopo, novaVersao } from '../orcamentos/servico.js';
import { abrirAditivo, conferirSemAlteracao, lerPedido, STATUS_PEDIDO } from '../pedidos/servico.js';
import { hojeLoja } from '../pedidos/dias-uteis.js';

/**
 * Agenda e medição técnica no local (especificação v1.1: seção 9 etapa 2, 12.5 e tabela 5.1).
 *
 * Caminho da medição:  AGENDADA -> REALIZADA (vãos e fotos registrados na obra) -> conferida
 *                      AGENDADA -> CANCELADA
 * A conferência é o passo que vale para o resto do sistema:
 *  - Pedido em "Conferência de medidas" (venda fechada antes da medição): sem alteração, o pedido segue
 *    para "Aguardando sinal" e a previsão de entrega (14 dias úteis) passa a contar de hoje; com
 *    alteração, abre o aditivo de medição (o prazo conta quando o aditivo é confirmado).
 *  - Orçamento ainda não aprovado: sem alteração, a versão fica marcada "medidas conferidas" (o PDF
 *    sai sem o aviso de conferência); com alteração, gera a nova versão (v2) para ajustar no configurador.
 *  - Sem orçamento: fica registrada; as medidas aparecem no configurador quando o orçamento do cliente for criado.
 *
 * Quem pode: o ADMIN tudo; o VENDEDOR as medições em que é o responsável (ou que ele marcou),
 * só para os clientes dele. O instalador é terceirizado e não tem login.
 */

type Tx = Parameters<Parameters<Banco['transaction']>[0]>[0];
type Exec = Banco | Tx;

export class ErroMedicao extends Error {
  constructor(message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); }
}

async function linhas<T>(db: Exec, q: SQL): Promise<T[]> {
  return (await db.execute(q)).rows as T[];
}

export const STATUS_MEDICAO: Record<string, string> = {
  AGENDADA: 'Agendada',
  REALIZADA: 'Medida (falta conferir)',
  CONFERIDA: 'Conferida',
  CANCELADA: 'Cancelada',
};

/** Status que o app mostra: REALIZADA + conferida_em vira CONFERIDA. */
const STATUS_EXIBIDO = sql`CASE WHEN m.status = 'REALIZADA' AND m.conferida_em IS NOT NULL THEN 'CONFERIDA' ELSE m.status::text END`;

export type Vao = {
  id: string; ambiente: string; descricao: string; tipo: 'CORTINA' | 'PERSIANA';
  modo: 'DENTRO_VAO' | 'FORA_VAO' | 'TETO' | null;
  larguras: string[]; alturas: string[];
  ladoComando: 'DIREITO' | 'ESQUERDO' | null; profundidadeCortineiroM: string | null;
  observacoes: string | null; itemId: string | null;
};

const ENDERECO = sql`NULLIF(CONCAT_WS(', ', NULLIF(CONCAT_WS(' ', c.logradouro, c.numero), ''), c.complemento, c.bairro,
  NULLIF(CONCAT_WS(' - ', c.cidade, c.uf), ''), CASE WHEN c.cep IS NOT NULL THEN 'CEP ' || c.cep END), '')`;

export type CabecalhoMedicao = {
  id: string; lojaId: string; numero: string; status: string; statusBanco: string;
  dataAgendada: string; duracaoHoras: string | null; dataRealizada: string | null; observacoes: string | null; obsCampo: string | null;
  responsavelId: string | null; responsavelNome: string | null; criadoPorId: string | null;
  clienteId: string; clienteNome: string; clienteTelefone: string; endereco: string | null; obsAcesso: string | null;
  clienteVendedorId: string | null;
  orcamentoId: string | null; grupoId: string | null; orcamentoCodigo: string | null;
  /** Versão mais nova do projeto (é ela que a medição confere). */
  orcamentoAtualId: string | null; orcamentoAtualVersao: number | null; orcamentoAtualStatus: string | null;
  pedidoId: string | null; pedidoNumero: string | null; pedidoStatus: string | null;
  vaos: Vao[]; registradoOffline: boolean; registroId: string | null;
  conferidaEm: string | null; conferidaPorNome: string | null; orcamentoGeradoId: string | null;
  canceladaEm: string | null; motivoCancelamento: string | null;
  /** Para detectar conflito na remarcação feita sem internet. */
  atualizadoEm: string;
};

const SELECT_MEDICAO = sql`
  SELECT m.id, m.loja_id AS "lojaId", m.numero, ${STATUS_EXIBIDO} AS status, m.status::text AS "statusBanco",
         m.data_agendada AS "dataAgendada", m.duracao_horas::text AS "duracaoHoras", m.data_realizada AS "dataRealizada",
         m.observacoes, m.obs_campo AS "obsCampo",
         m.tecnico_id AS "responsavelId", r.nome AS "responsavelNome", m.criado_por_id AS "criadoPorId",
         c.id AS "clienteId", c.nome_completo AS "clienteNome", c.telefone_whatsapp AS "clienteTelefone",
         ${ENDERECO} AS endereco, c.obs_acesso_instalacao AS "obsAcesso", c.vendedor_responsavel_id AS "clienteVendedorId",
         m.orcamento_id AS "orcamentoId", o.grupo_id AS "grupoId", o.codigo_sequencial AS "orcamentoCodigo",
         ult.id AS "orcamentoAtualId", ult.versao AS "orcamentoAtualVersao", ult.status::text AS "orcamentoAtualStatus",
         p.id AS "pedidoId", p.numero_pedido AS "pedidoNumero", p.status_operacional::text AS "pedidoStatus",
         m.vaos, m.registrado_offline AS "registradoOffline", m.registro_id AS "registroId",
         m.conferida_em AS "conferidaEm", cf.nome AS "conferidaPorNome", m.orcamento_gerado_id AS "orcamentoGeradoId",
         m.cancelada_em AS "canceladaEm", m.motivo_cancelamento AS "motivoCancelamento",
         to_char(m.atualizado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "atualizadoEm"
    FROM medicoes m
    JOIN clientes c ON c.id = m.cliente_id
    LEFT JOIN usuarios r ON r.id = m.tecnico_id
    LEFT JOIN usuarios cf ON cf.id = m.conferida_por_id
    LEFT JOIN orcamentos o ON o.id = m.orcamento_id
    LEFT JOIN LATERAL (SELECT id, versao, status FROM orcamentos x WHERE x.grupo_id = o.grupo_id ORDER BY versao DESC LIMIT 1) ult ON TRUE
    LEFT JOIN pedidos p ON p.grupo_orcamento_id = o.grupo_id`;

/** Medições que o usuário enxerga (o ADMIN vê todas da loja). */
export function escopoMedicao(u: UsuarioSessao): SQL {
  return sql`m.loja_id = ${u.lojaId} AND (${pode(u, 'medicoes.todas')}::boolean OR m.tecnico_id = ${u.id} OR m.criado_por_id = ${u.id})`;
}

export function medicaoNoEscopo(u: UsuarioSessao, m: Pick<CabecalhoMedicao, 'lojaId' | 'responsavelId' | 'criadoPorId'>) {
  return m.lojaId === u.lojaId && (pode(u, 'medicoes.todas') || m.responsavelId === u.id || m.criadoPorId === u.id);
}

export async function lerMedicao(db: Exec, id: string): Promise<CabecalhoMedicao | null> {
  const [m] = await linhas<CabecalhoMedicao>(db, sql`${SELECT_MEDICAO} WHERE m.id = ${id}`);
  return m ?? null;
}

async function medicaoDoUsuario(db: Exec, u: UsuarioSessao, id: string, travar = false) {
  if (travar) await db.execute(sql`SELECT id FROM medicoes WHERE id = ${id} FOR UPDATE`);
  const m = await lerMedicao(db, id);
  if (!m || !medicaoNoEscopo(u, m)) throw new ErroMedicao('Medição não encontrada.', 404);
  return m;
}

type FotoInfo = { id: string; vaoId: string | null; legenda: string | null; tamanho: number; criadoEm: string };

async function fotosDa(db: Exec, ids: string[]): Promise<Map<string, FotoInfo[]>> {
  const mapa = new Map<string, FotoInfo[]>();
  if (!ids.length) return mapa;
  const rows = await linhas<FotoInfo & { medicaoId: string }>(db, sql`
    SELECT id, medicao_id AS "medicaoId", vao_id AS "vaoId", legenda, tamanho, criado_em AS "criadoEm"
      FROM medicao_fotos WHERE medicao_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) ORDER BY criado_em`);
  for (const r of rows) {
    const { medicaoId, ...f } = r;
    mapa.set(medicaoId, [...(mapa.get(medicaoId) ?? []), f]);
  }
  return mapa;
}

/** Itens do orçamento (versão mais nova) para ligar cada vão ao item que ele confere. */
async function itensDoOrcamento(db: Exec, orcamentoId: string | null) {
  if (!orcamentoId) return [];
  return linhas<{ id: string; ambiente: string; tipo: string; descricao: string; larguraBruta: string | null; alturaBruta: string | null; larguraProducao: string; alturaProducao: string }>(db, sql`
    SELECT id, ambiente, tipo_item::text AS tipo, descricao_comercial AS descricao,
           largura_bruta_m::text AS "larguraBruta", altura_bruta_m::text AS "alturaBruta",
           largura_producao_m::text AS "larguraProducao", altura_producao_m::text AS "alturaProducao"
      FROM orcamento_itens_compostos WHERE orcamento_id = ${orcamentoId} AND tipo_item <> 'SERVICO' ORDER BY ordem, id`);
}

/** O que a conferência pode fazer agora (o app mostra só os botões que valem). */
function acoesConferencia(m: CabecalhoMedicao): { pode: boolean; destino: 'PEDIDO' | 'ORCAMENTO' | 'NENHUM' | 'REGISTRO'; explicacao: string } {
  if (m.statusBanco !== 'REALIZADA' || m.conferidaEm) return { pode: false, destino: 'NENHUM', explicacao: '' };
  if (m.pedidoId) {
    if (m.pedidoStatus === 'CONFERENCIA_MEDIDAS') {
      return { pode: true, destino: 'PEDIDO', explicacao: `O pedido ${m.pedidoNumero} está esperando esta medição. Conferindo, a previsão de entrega passa a contar a partir de hoje.` };
    }
    return { pode: true, destino: 'REGISTRO', explicacao: `O pedido ${m.pedidoNumero} já está ${STATUS_PEDIDO[m.pedidoStatus ?? '']?.toLowerCase() ?? ''}: a conferência fica só registrada.` };
  }
  if (m.orcamentoAtualId && !['PERDIDO', 'EXPIRADO'].includes(m.orcamentoAtualStatus ?? '')) {
    return { pode: true, destino: 'ORCAMENTO', explicacao: `Orçamento ${m.orcamentoCodigo}: se as medidas mudaram, o sistema cria a nova versão para você ajustar.` };
  }
  return { pode: true, destino: 'REGISTRO', explicacao: 'Sem orçamento ligado: as medidas aparecem no configurador quando o orçamento deste cliente for criado.' };
}

export async function montarMedicao(db: Exec, u: UsuarioSessao, id: string) {
  const m = await medicaoDoUsuario(db, u, id);
  const fotos = (await fotosDa(db, [m.id])).get(m.id) ?? [];
  const itens = await itensDoOrcamento(db, m.orcamentoAtualId);
  return { ...m, statusNome: STATUS_MEDICAO[m.status] ?? m.status, fotos, itens, conferencia: acoesConferencia(m) };
}
export type MedicaoMontada = Awaited<ReturnType<typeof montarMedicao>>;

// ------------------------------------------------------------------ agenda

export type FiltroAgenda = { de: string; ate: string; responsavelId?: string | null };

export async function listarAgenda(db: Banco, u: UsuarioSessao, f: FiltroAgenda) {
  const todas = pode(u, 'medicoes.todas');
  const resp = todas ? (f.responsavelId ?? null) : null;
  const dia = (col: SQL) => sql`(${col} AT TIME ZONE 'America/Sao_Paulo')::date`;

  const medicoes = await linhas<CabecalhoMedicao>(db, sql`${SELECT_MEDICAO}
    WHERE ${escopoMedicao(u)} AND ${dia(sql`m.data_agendada`)} BETWEEN ${f.de}::date AND ${f.ate}::date
      AND (${resp}::uuid IS NULL OR m.tecnico_id = ${resp}::uuid)
    ORDER BY m.data_agendada`);

  // Instalações (o agendamento é feito no pedido). O vendedor vê as dos pedidos dele.
  const instalacoes = await linhas<{
    id: string; numero: string; titulo: string | null; status: string; data: string; duracaoHoras: string | null;
    clienteNome: string; clienteTelefone: string; endereco: string | null; instaladorNome: string | null; vendedorId: string; vendedorNome: string;
  }>(db, sql`
    SELECT p.id, p.numero_pedido AS numero, p.titulo, p.status_operacional::text AS status, p.data_instalacao_agendada AS data,
           p.instalacao_duracao_horas::text AS "duracaoHoras", c.nome_completo AS "clienteNome", c.telefone_whatsapp AS "clienteTelefone",
           ${ENDERECO} AS endereco, f.nome_fantasia AS "instaladorNome", p.vendedor_id AS "vendedorId", u.nome AS "vendedorNome"
      FROM pedidos p JOIN clientes c ON c.id = p.cliente_id JOIN usuarios u ON u.id = p.vendedor_id
      LEFT JOIN fornecedores f ON f.id = p.instalador_fornecedor_id
     WHERE p.loja_id = ${u.lojaId} AND (${pode(u, 'pedidos.todos')}::boolean OR p.vendedor_id = ${u.id})
       AND p.data_instalacao_agendada IS NOT NULL AND p.status_operacional <> 'CANCELADO'
       AND ${dia(sql`p.data_instalacao_agendada`)} BETWEEN ${f.de}::date AND ${f.ate}::date
       AND (${resp}::uuid IS NULL OR p.vendedor_id = ${resp}::uuid)
     ORDER BY p.data_instalacao_agendada`);

  // Pendências: quem espera medição sem visita marcada, e medições feitas que faltam conferir.
  const semVisita = await linhas<{ tipo: 'ORCAMENTO' | 'PEDIDO'; id: string; orcamentoId: string; codigo: string; clienteId: string; clienteNome: string; vendedorNome: string; status: string; desde: string }>(db, sql`
    SELECT 'PEDIDO' AS tipo, p.id, p.orcamento_id AS "orcamentoId", p.numero_pedido AS codigo, c.id AS "clienteId", c.nome_completo AS "clienteNome",
           u.nome AS "vendedorNome", p.status_operacional::text AS status, p.data_compra AS desde
      FROM pedidos p JOIN clientes c ON c.id = p.cliente_id JOIN usuarios u ON u.id = p.vendedor_id
     WHERE p.loja_id = ${u.lojaId} AND (${pode(u, 'pedidos.todos')}::boolean OR p.vendedor_id = ${u.id})
       AND p.status_operacional = 'CONFERENCIA_MEDIDAS'
       AND NOT EXISTS (SELECT 1 FROM medicoes m JOIN orcamentos o ON o.id = m.orcamento_id
                        WHERE o.grupo_id = p.grupo_orcamento_id AND m.status IN ('AGENDADA', 'REALIZADA'))
    UNION ALL
    SELECT 'ORCAMENTO', o.id, o.id, o.codigo_sequencial || ' v' || o.versao, c.id, c.nome_completo, u.nome, o.status::text, o.atualizado_em
      FROM orcamentos o JOIN clientes c ON c.id = o.cliente_id JOIN usuarios u ON u.id = o.vendedor_id
     WHERE o.loja_id = ${u.lojaId} AND (${pode(u, 'orcamentos.todos')}::boolean OR o.vendedor_id = ${u.id})
       AND o.status = 'AGUARDANDO_MEDICAO'
       AND o.versao = (SELECT MAX(versao) FROM orcamentos x WHERE x.grupo_id = o.grupo_id)
       AND NOT EXISTS (SELECT 1 FROM medicoes m JOIN orcamentos x ON x.id = m.orcamento_id
                        WHERE x.grupo_id = o.grupo_id AND m.status IN ('AGENDADA', 'REALIZADA'))
     ORDER BY desde`);

  const aConferir = await linhas<CabecalhoMedicao>(db, sql`${SELECT_MEDICAO}
    WHERE ${escopoMedicao(u)} AND m.status = 'REALIZADA' AND m.conferida_em IS NULL ORDER BY m.data_realizada`);
  const atrasadas = await linhas<CabecalhoMedicao>(db, sql`${SELECT_MEDICAO}
    WHERE ${escopoMedicao(u)} AND m.status = 'AGENDADA' AND ${dia(sql`m.data_agendada`)} < ${hojeLoja()}::date ORDER BY m.data_agendada`);

  const resumo = (m: CabecalhoMedicao) => ({
    id: m.id, numero: m.numero, status: m.status, statusNome: STATUS_MEDICAO[m.status] ?? m.status,
    dataAgendada: m.dataAgendada, duracaoHoras: m.duracaoHoras, clienteNome: m.clienteNome, clienteTelefone: m.clienteTelefone,
    endereco: m.endereco, responsavelNome: m.responsavelNome, orcamentoCodigo: m.orcamentoCodigo, pedidoNumero: m.pedidoNumero,
    observacoes: m.observacoes, qtdVaos: m.vaos.length,
  });
  return {
    de: f.de, ate: f.ate,
    medicoes: medicoes.map(resumo),
    instalacoes,
    pendencias: { semVisita, aConferir: aConferir.map(resumo), atrasadas: atrasadas.map(resumo) },
  };
}

/** Projetos do cliente que podem ser ligados à visita (versão mais nova de cada orçamento em aberto). */
export async function projetosDoCliente(db: Banco, u: UsuarioSessao, clienteId: string) {
  return linhas<{ orcamentoId: string; codigo: string; versao: number; titulo: string | null; status: string; pedidoNumero: string | null; pedidoStatus: string | null }>(db, sql`
    SELECT o.id AS "orcamentoId", o.codigo_sequencial AS codigo, o.versao, o.titulo, o.status::text AS status,
           p.numero_pedido AS "pedidoNumero", p.status_operacional::text AS "pedidoStatus"
      FROM orcamentos o LEFT JOIN pedidos p ON p.grupo_orcamento_id = o.grupo_id
     WHERE o.cliente_id = ${clienteId} AND o.loja_id = ${u.lojaId}
       AND (${pode(u, 'orcamentos.todos')}::boolean OR o.vendedor_id = ${u.id})
       AND o.versao = (SELECT MAX(versao) FROM orcamentos x WHERE x.grupo_id = o.grupo_id)
       AND o.status NOT IN ('PERDIDO', 'EXPIRADO')
       AND (p.id IS NULL OR p.status_operacional NOT IN ('CANCELADO', 'INSTALADO_CONCLUIDO'))
     ORDER BY o.data_criacao DESC LIMIT 30`);
}

// ------------------------------------------------------------------ agendar, remarcar, cancelar

export type EntradaAgendar = {
  /** Gerado no aparelho (marcação feita sem internet): reenviar não duplica. */
  id?: string | null;
  clienteId: string; orcamentoId?: string | null; dataAgendada: string; duracaoHoras?: string | null;
  responsavelId?: string | null; observacoes?: string | null;
};

async function validarResponsavel(tx: Exec, u: UsuarioSessao, responsavelId: string | null | undefined): Promise<string> {
  if (!pode(u, 'medicoes.todas') || !responsavelId) return u.id;
  const [r] = await linhas<{ id: string }>(tx, sql`SELECT id FROM usuarios WHERE id = ${responsavelId} AND loja_id = ${u.lojaId} AND ativo`);
  if (!r) throw new ErroMedicao('Responsável não encontrado (ou inativo).');
  return r.id;
}

/** Avisa se o responsável já tem compromisso no mesmo dia (não bloqueia). */
async function avisosDeHorario(tx: Exec, lojaId: string, responsavelId: string, data: string, ignorarId: string | null): Promise<string[]> {
  const [r] = await linhas<{ med: number; inst: number; nome: string }>(tx, sql`
    SELECT (SELECT COUNT(*)::int FROM medicoes m WHERE m.loja_id = ${lojaId} AND m.tecnico_id = ${responsavelId} AND m.status = 'AGENDADA'
              AND (${ignorarId}::uuid IS NULL OR m.id <> ${ignorarId}::uuid)
              AND abs(extract(epoch FROM m.data_agendada - ${data}::timestamptz)) < 7200) AS med,
           (SELECT COUNT(*)::int FROM pedidos p WHERE p.loja_id = ${lojaId} AND p.vendedor_id = ${responsavelId}
              AND p.status_operacional = 'INSTALACAO_AGENDADA'
              AND abs(extract(epoch FROM p.data_instalacao_agendada - ${data}::timestamptz)) < 7200) AS inst,
           (SELECT nome FROM usuarios WHERE id = ${responsavelId}) AS nome`);
  const n = (r?.med ?? 0) + (r?.inst ?? 0);
  return n ? [`${r!.nome} já tem ${n} compromisso(s) a menos de 2 horas deste horário. Confira se dá tempo.`] : [];
}

export async function agendarMedicao(db: Banco, u: UsuarioSessao, e: EntradaAgendar) {
  return db.transaction(async (tx) => {
    if (e.id) {
      const [ja] = await linhas<{ id: string; numero: string; lojaId: string; criadoPorId: string }>(tx, sql`
        SELECT id, numero, loja_id AS "lojaId", criado_por_id AS "criadoPorId" FROM medicoes WHERE id = ${e.id}`);
      if (ja) {
        if (ja.lojaId !== u.lojaId || ja.criadoPorId !== u.id) throw new ErroMedicao('Medição já existe.', 409);
        return { id: ja.id, numero: ja.numero, avisos: [] as string[], repetido: true };
      }
    }
    const [cli] = await linhas<{ id: string }>(tx, sql`
      SELECT id FROM clientes WHERE id = ${e.clienteId} AND loja_id = ${u.lojaId} AND ativo
         AND (${pode(u, 'clientes.todos')}::boolean OR vendedor_responsavel_id = ${u.id})`);
    if (!cli) throw new ErroMedicao('Cliente não encontrado.', 404);
    let orcamentoId: string | null = null;
    if (e.orcamentoId) {
      const c = await lerCabecalho(tx, e.orcamentoId);
      if (!c || !noEscopo(u, c) || c.clienteId !== e.clienteId) throw new ErroMedicao('Orçamento não encontrado para este cliente.', 404);
      const ult = (await lerCabecalho(tx, c.versaoMaisNovaId))!;
      if (['PERDIDO', 'EXPIRADO'].includes(ult.status)) throw new ErroMedicao(`O orçamento ${c.codigo} está ${ult.status === 'PERDIDO' ? 'perdido' : 'vencido'}.`, 409);
      orcamentoId = ult.id;
      // Proposta enviada + visita marcada = "Aguardando medição" (caminho normal da etapa 2).
      if (ult.status === 'ENVIADO') {
        await tx.execute(sql`UPDATE orcamentos SET status = 'AGUARDANDO_MEDICAO', atualizado_em = date_trunc('milliseconds', clock_timestamp()) WHERE id = ${ult.id}`);
        await auditar(tx, ult.id, u.id, [{ acao: 'STATUS', descricao: 'Aguardando medição (visita agendada).', detalhes: { de: 'ENVIADO', para: 'AGUARDANDO_MEDICAO' } }]);
      }
    }
    const responsavel = await validarResponsavel(tx, u, e.responsavelId);
    const avisos = await avisosDeHorario(tx, u.lojaId, responsavel, e.dataAgendada, null);
    const [n] = await linhas<{ n: string }>(tx, sql`SELECT nextval('medicao_numero_seq')::text AS n`);
    const numero = `MED-${hojeLoja().slice(0, 4)}-${n!.n.padStart(4, '0')}`;
    const [m] = await linhas<{ id: string }>(tx, sql`
      INSERT INTO medicoes (id, loja_id, numero, cliente_id, orcamento_id, tecnico_id, status, data_agendada, duracao_horas, observacoes, criado_por_id)
      VALUES (COALESCE(${e.id ?? null}::uuid, gen_random_uuid()), ${u.lojaId}, ${numero}, ${e.clienteId}, ${orcamentoId}, ${responsavel}, 'AGENDADA', ${e.dataAgendada}::timestamptz,
              ${e.duracaoHoras ?? null}, ${e.observacoes ?? null}, ${u.id})
      RETURNING id`);
    return { id: m!.id, numero, avisos, repetido: false };
  });
}

export async function remarcarMedicao(db: Banco, u: UsuarioSessao, id: string, e: Omit<EntradaAgendar, 'clienteId' | 'orcamentoId' | 'id'> & { atualizadoEmBase?: string | null }) {
  return db.transaction(async (tx) => {
    const m = await medicaoDoUsuario(tx, u, id, true);
    // Remarcação feita sem internet: se outra pessoa mexeu na visita depois, não sobrescreve.
    if (e.atualizadoEmBase && new Date(m.atualizadoEm).getTime() > new Date(e.atualizadoEmBase).getTime()) {
      throw new ErroMedicao(`A visita ${m.numero} foi alterada por outra pessoa enquanto você estava sem internet (agora: ${new Date(m.dataAgendada).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })}, ${m.responsavelNome ?? ''}). A sua remarcação não foi aplicada: confira e remarque de novo.`, 409, { conflito: true });
    }
    if (m.statusBanco !== 'AGENDADA') throw new ErroMedicao('Só dá para remarcar uma medição ainda não feita.', 409);
    const responsavel = pode(u, 'medicoes.todas') ? await validarResponsavel(tx, u, e.responsavelId ?? m.responsavelId) : (m.responsavelId ?? u.id);
    const avisos = await avisosDeHorario(tx, u.lojaId, responsavel, e.dataAgendada, m.id);
    await tx.execute(sql`UPDATE medicoes SET data_agendada = ${e.dataAgendada}::timestamptz, duracao_horas = ${e.duracaoHoras ?? null},
      tecnico_id = ${responsavel}, observacoes = ${e.observacoes ?? null}, atualizado_em = NOW() WHERE id = ${m.id}`);
    return { avisos };
  });
}

export async function cancelarMedicao(db: Banco, u: UsuarioSessao, id: string, motivo: string) {
  await db.transaction(async (tx) => {
    const m = await medicaoDoUsuario(tx, u, id, true);
    if (m.statusBanco !== 'AGENDADA') throw new ErroMedicao('Só dá para cancelar uma medição ainda não feita.', 409);
    await tx.execute(sql`UPDATE medicoes SET status = 'CANCELADA', cancelada_em = NOW(), motivo_cancelamento = ${motivo}, atualizado_em = NOW()
      WHERE id = ${m.id}`);
  });
}

// ------------------------------------------------------------------ registro na obra (offline)

export type EntradaRegistro = { registroId: string; vaos: Vao[]; obsCampo: string | null; realizadaEm: string; offline?: boolean };

/**
 * Grava os vãos medidos na obra. Pode vir da fila do aparelho (sem internet): o registroId nasce no
 * aparelho, então reenviar o mesmo registro não faz nada. Um registro novo substitui o anterior
 * enquanto a medição não foi conferida (ex.: voltou à obra para medir de novo).
 */
export async function registrarMedicao(db: Banco, u: UsuarioSessao, id: string, e: EntradaRegistro) {
  return db.transaction(async (tx) => {
    const m = await medicaoDoUsuario(tx, u, id, true);
    if (m.registroId === e.registroId) return { repetido: true };
    if (m.statusBanco === 'CANCELADA') throw new ErroMedicao('Esta medição foi cancelada. Peça para marcar de novo.', 409);
    if (m.conferidaEm) throw new ErroMedicao('Esta medição já foi conferida: as medidas não mudam mais. Para mudar, marque nova medição.', 409);
    if (!e.vaos.length) throw new ErroMedicao('Registre ao menos um vão.');
    const ids = new Set<string>();
    for (const v of e.vaos) {
      if (ids.has(v.id)) throw new ErroMedicao('Vão repetido no registro.');
      ids.add(v.id);
    }
    await tx.execute(sql`UPDATE medicoes SET status = 'REALIZADA', data_realizada = ${e.realizadaEm}::timestamptz,
      vaos = ${JSON.stringify(e.vaos)}::jsonb, obs_campo = ${e.obsCampo}, registro_id = ${e.registroId},
      registrado_offline = ${Boolean(e.offline)}, registrado_por_id = ${u.id}, atualizado_em = NOW() WHERE id = ${m.id}`);
    return { repetido: false };
  });
}

export type EntradaFoto = { id: string; vaoId: string | null; legenda: string | null; mime: string; conteudo: Buffer };

/** Foto do vão (uma por chamada, para não estourar na rede ruim). O id vem do aparelho: reenviar não duplica. */
export async function salvarFoto(db: Banco, u: UsuarioSessao, medicaoId: string, f: EntradaFoto) {
  const m = await medicaoDoUsuario(db, u, medicaoId);
  if (m.statusBanco === 'CANCELADA') throw new ErroMedicao('Esta medição foi cancelada.', 409);
  const [qtd] = await linhas<{ n: number }>(db, sql`SELECT COUNT(*)::int AS n FROM medicao_fotos WHERE medicao_id = ${m.id}`);
  if ((qtd?.n ?? 0) >= 80) throw new ErroMedicao('Limite de 80 fotos por medição.', 409);
  const r = await db.execute(sql`
    INSERT INTO medicao_fotos (id, medicao_id, vao_id, legenda, mime, tamanho, conteudo, enviado_por_id)
    VALUES (${f.id}, ${m.id}, ${f.vaoId}, ${f.legenda}, ${f.mime}, ${f.conteudo.length}, ${f.conteudo}, ${u.id})
    ON CONFLICT (id) DO NOTHING`);
  if (!r.rowCount) {
    const [dono] = await linhas<{ medicaoId: string }>(db, sql`SELECT medicao_id AS "medicaoId" FROM medicao_fotos WHERE id = ${f.id}`);
    if (dono && dono.medicaoId !== m.id) throw new ErroMedicao('Foto de outra medição.', 409);
    return { repetida: true };
  }
  return { repetida: false };
}

export async function apagarFoto(db: Banco, u: UsuarioSessao, medicaoId: string, fotoId: string) {
  const m = await medicaoDoUsuario(db, u, medicaoId);
  if (m.conferidaEm) throw new ErroMedicao('Medição conferida: as fotos ficam guardadas.', 409);
  await db.execute(sql`DELETE FROM medicao_fotos WHERE id = ${fotoId} AND medicao_id = ${m.id}`);
}

/** Conteúdo da foto, se o usuário enxerga a medição (ou o pedido dela). */
export async function lerFoto(db: Banco, u: UsuarioSessao, fotoId: string) {
  const [f] = await linhas<{ medicaoId: string; mime: string; conteudo: Buffer }>(db, sql`
    SELECT medicao_id AS "medicaoId", mime, conteudo FROM medicao_fotos WHERE id = ${fotoId}`);
  if (!f) return null;
  const m = await lerMedicao(db, f.medicaoId);
  if (!m || m.lojaId !== u.lojaId) return null;
  if (medicaoNoEscopo(u, m)) return f;
  // O vendedor do pedido/orçamento também vê as fotos (ex.: medição feita por outra pessoa).
  if (m.orcamentoAtualId) {
    const c = await lerCabecalho(db, m.orcamentoAtualId);
    if (c && noEscopo(u, c)) return f;
  }
  return null;
}

// ------------------------------------------------------------------ conferência

export type ResultadoConferencia = { mensagem: string; orcamentoId: string | null; pedidoId: string | null };

/**
 * Confere a medição. `alterou` = as medidas tiradas na obra mudam o que foi vendido/orçado.
 * Veja o comentário do topo para o efeito em cada caso.
 */
export async function conferirMedicao(db: Banco, u: UsuarioSessao, id: string, alterou: boolean, conferidaEm?: string | null): Promise<ResultadoConferencia> {
  const m = await medicaoDoUsuario(db, u, id);
  const a = acoesConferencia(m);
  if (!a.pode) {
    if (m.conferidaEm) throw new ErroMedicao('Esta medição já foi conferida.', 409, { jaConferida: true });
    throw new ErroMedicao(m.statusBanco === 'CANCELADA' ? 'Esta medição foi cancelada.' : 'Registre as medidas da obra antes de conferir.', 409);
  }
  // Conferida sem internet: o prazo conta do dia em que foi conferida no aparelho (nunca no futuro).
  const diaConferencia = conferidaEm ? hojeLoja(new Date(Math.min(Date.parse(conferidaEm), Date.now()))) : hojeLoja();
  if (!m.vaos.length) throw new ErroMedicao('Registre ao menos um vão antes de conferir.', 409);

  const marcar = async (gerado: string | null) => {
    await db.execute(sql`UPDATE medicoes SET conferida_em = NOW(), conferida_por_id = ${u.id},
      orcamento_gerado_id = COALESCE(${gerado}::uuid, orcamento_gerado_id), atualizado_em = NOW()
      WHERE id = ${m.id} AND conferida_em IS NULL`);
  };

  if (a.destino === 'PEDIDO') {
    const p = (await lerPedido(db, m.pedidoId!))!;
    if (!alterou) {
      // conferirSemAlteracao marca esta medição como conferida (marcarMedicoesConferidas).
      await conferirSemAlteracao(db, u, p.id, diaConferencia);
      return { mensagem: `Medidas conferidas. O pedido ${p.numero} seguiu para "Aguardando sinal" e o prazo de entrega conta a partir de ${diaConferencia.split('-').reverse().join('/')}.`, orcamentoId: null, pedidoId: p.id };
    }
    const r = await abrirAditivo(db, u, p.id, `Medição ${m.numero}`);
    await db.execute(sql`UPDATE medicoes SET orcamento_gerado_id = ${r.orcamentoId}, atualizado_em = NOW() WHERE id = ${m.id}`);
    return {
      mensagem: `Aditivo de medição aberto no pedido ${p.numero}. Ajuste os itens com as medidas da obra e confirme no pedido: o prazo começa a contar na confirmação.`,
      orcamentoId: r.orcamentoId, pedidoId: p.id,
    };
  }

  if (a.destino === 'ORCAMENTO') {
    const ult = (await lerCabecalho(db, m.orcamentoAtualId!))!;
    if (!noEscopo(u, ult)) throw new ErroMedicao('Só o vendedor do orçamento (ou o administrador) confere esta medição.', 403);
    if (ult.status === 'AGUARDANDO_MEDICAO') {
      await db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE orcamentos SET status = 'EM_NEGOCIACAO', atualizado_em = date_trunc('milliseconds', clock_timestamp()) WHERE id = ${ult.id}`);
        await auditar(tx, ult.id, u.id, [{ acao: 'STATUS', descricao: `Em negociação (medição ${m.numero} conferida).`, detalhes: { de: 'AGUARDANDO_MEDICAO', para: 'EM_NEGOCIACAO' } }]);
      });
    }
    let alvo = ult.id;
    if (alterou && ult.status !== 'RASCUNHO') alvo = await novaVersao(db, u, ult.id, false);
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE orcamentos SET medidas_conferidas = TRUE WHERE id = ${alvo}`);
      await auditar(tx, alvo, u.id, [{ acao: 'MEDICAO', descricao: `Medidas conferidas no local (medição ${m.numero}).`, detalhes: { medicaoId: m.id } }]);
    });
    await marcar(alvo === ult.id ? null : alvo);
    const novo = alvo !== ult.id ? (await lerCabecalho(db, alvo))! : null;
    return {
      mensagem: novo
        ? `Criada a v${novo.versao} do orçamento ${novo.codigo}. Use o quadro "Medidas tiradas no local" para passar as medidas aos itens e envie de novo ao cliente.`
        : alterou
          ? `O orçamento ${ult.codigo} v${ult.versao} ainda é rascunho: ajuste os itens com as medidas da obra.`
          : `Medidas conferidas. A proposta ${ult.codigo} v${ult.versao} sai sem o aviso de conferência técnica.`,
      orcamentoId: alvo, pedidoId: null,
    };
  }

  await marcar(null);
  return { mensagem: a.destino === 'REGISTRO' && m.pedidoId ? 'Medição conferida (registro).' : 'Medição conferida. As medidas vão aparecer no configurador quando o orçamento deste cliente for criado.', orcamentoId: null, pedidoId: m.pedidoId };
}

// ------------------------------------------------------------------ medidas para o configurador

/** Medições feitas do projeto (ou do cliente, sem orçamento ligado) para usar no configurador. */
export async function medicoesDoOrcamento(db: Banco, u: UsuarioSessao, orcamentoId: string) {
  const c = await lerCabecalho(db, orcamentoId);
  if (!c || !noEscopo(u, c)) return null;
  const ms = await linhas<CabecalhoMedicao>(db, sql`${SELECT_MEDICAO}
    WHERE m.loja_id = ${u.lojaId} AND m.status = 'REALIZADA'
      AND (o.grupo_id = ${c.grupoId} OR (m.orcamento_id IS NULL AND m.cliente_id = ${c.clienteId}))
    ORDER BY m.data_realizada DESC LIMIT 10`);
  const fotos = await fotosDa(db, ms.map((m) => m.id));
  return ms.map((m) => ({
    id: m.id, numero: m.numero, status: m.status, statusNome: STATUS_MEDICAO[m.status], dataRealizada: m.dataRealizada,
    responsavelNome: m.responsavelNome, obsCampo: m.obsCampo, vaos: m.vaos, fotos: fotos.get(m.id) ?? [], ligadaAoProjeto: m.grupoId === c.grupoId,
  }));
}

// ------------------------------------------------------------------ pacote para a obra (offline)

/** Visitas do usuário (de ontem até 30 dias) e medidas ainda não conferidas, com o que precisa na obra. */
export async function pacoteOffline(db: Banco, u: UsuarioSessao) {
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT m.id FROM medicoes m
     WHERE m.loja_id = ${u.lojaId} AND (m.tecnico_id = ${u.id} OR (${pode(u, 'medicoes.todas')}::boolean AND m.tecnico_id IS NULL))
       AND ((m.status = 'AGENDADA' AND m.data_agendada >= CURRENT_DATE - 1 AND m.data_agendada < CURRENT_DATE + 31)
         OR (m.status = 'REALIZADA' AND m.conferida_em IS NULL))
     ORDER BY m.data_agendada LIMIT 60`);
  const medicoes = [];
  for (const r of rows) medicoes.push(await montarMedicao(db, u, r.id));
  return { geradoEm: new Date().toISOString(), medicoes };
}

/** Medida em metros com 2 casas, para textos ("2,43 m"). */
export function metrosTxt(v: string | null | undefined) {
  return v ? `${d(v).toFixed(2).replace('.', ',')} m` : '-';
}
