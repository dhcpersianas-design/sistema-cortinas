import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar } from './ajuda.js';
import { somarDiasUteis } from '../src/pedidos/dias-uteis.js';

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, ana: string, beto: string;
let clienteAna: string;
let costureira: string, tecidos: string, fabrica: string, instalador: string;

const cortina = {
  larguraTrilho: '3.00', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE',
  tecido: { sku: 'TEC-001', fator: '2.5', margemBarra: '0.30' },
  forro: { sku: 'TEC-002', fator: '2.0', margemBarra: '0.20', desconto: '0.05' },
  skus: { trilho: 'TRI-002' },
};
const persiana = {
  sku: 'PER-001', medida: { tipo: 'PRODUCAO', largura: '1.40', altura: '1.00' },
  acionamento: 'MOTORIZADO', ladoComando: 'DIREITO', sentidoEnrolamento: 'NORMAL', possuiBando: true,
};
// PNG 1x1 válido (assinatura de teste)
const PNG = 'data:image/png;base64,' + Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082'
  + '00'.repeat(60), 'hex').toString('base64');

async function req(cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

/** Cria um orçamento com cortina + persiana, envia e devolve o id. */
async function orcamentoEnviado(cookie: string, clienteId: string, medidasConferidas = false) {
  const id = randomUUID();
  const r = await req(cookie, 'PUT', `/api/orcamentos/${id}`, {
    clienteId, titulo: 'Apto 302',
    condicoes: { descontoTipo: 'PERCENTUAL', descontoValor: '0', acrescimo: '0', parcelas: 1, medidasConferidas, formaPagamento: 'PIX' },
    itens: [
      { id: randomUUID(), ambiente: 'Sala', tipo: 'CORTINA', entrada: cortina, ajustes: [] },
      { id: randomUUID(), ambiente: 'Quarto', tipo: 'PERSIANA', entrada: persiana, ajustes: [] },
    ],
  });
  expect(r.statusCode, r.body).toBe(200);
  const env = await req(cookie, 'POST', `/api/orcamentos/${id}/status`, { status: 'ENVIADO' });
  expect(env.statusCode, env.body).toBe(200);
  return id;
}

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  await criarUsuario(pool, { email: 'ana@loja.com', perfil: 'VENDEDOR' });
  await criarUsuario(pool, { email: 'beto@loja.com', perfil: 'VENDEDOR' });
  app = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  ana = await entrar(app, 'ana@loja.com');
  beto = await entrar(app, 'beto@loja.com');
  clienteAna = (await req(ana, 'POST', '/api/clientes', { nomeCompleto: 'João da Conceição', telefoneWhatsapp: '11 98765-4321', cidade: 'São Paulo', uf: 'SP', obsAcessoInstalacao: 'Portaria só até 17h' })).json().cliente.id;
  const forn = async (nome: string, categoria: string, extra: object = {}) =>
    (await req(admin, 'POST', '/api/fornecedores', { nomeFantasia: nome, categoria, whatsapp: '11 91234-5678', ...extra })).json().fornecedor.id as string;
  tecidos = await forn('Tecidos Brasil', 'TECIDO', { prazoEntregaDias: 5 });
  costureira = await forn('Ateliê da Rosa', 'COSTUREIRA');
  fabrica = await forn('Fábrica Rolo', 'PERSIANA');
  instalador = await forn('Zé Instalações', 'INSTALADOR');
  // Fornecedor padrão no catálogo: tecido -> loja de tecidos; mão de obra -> costureira; persiana -> fábrica.
  await pool.query(`UPDATE produtos SET fornecedor_padrao_id = $1 WHERE categoria_id = 1`, [tecidos]);
  await pool.query(`UPDATE produtos SET fornecedor_padrao_id = $1 WHERE categoria_id = 5`, [costureira]);
  await pool.query(`UPDATE produtos SET fornecedor_padrao_id = $1 WHERE categoria_id IN (6, 7, 8)`, [fabrica]);
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('dias úteis', () => {
  it('pula sábado e domingo', () => {
    expect(somarDiasUteis('2026-11-27', 1)).toBe('2026-11-30'); // sexta + 1 = segunda
    expect(somarDiasUteis('2026-11-27', 14)).toBe('2026-12-17');
    expect(somarDiasUteis('2026-11-28', 0)).toBe('2026-11-28');
  });
});

describe('aprovação: orçamento vira pedido', () => {
  it('rascunho não pode ser aprovado; enviado vira pedido em CONFERENCIA_MEDIDAS', async () => {
    const rasc = randomUUID();
    await req(ana, 'PUT', `/api/orcamentos/${rasc}`, { clienteId: clienteAna, itens: [{ id: randomUUID(), ambiente: 'Sala', tipo: 'CORTINA', entrada: cortina, ajustes: [] }] });
    expect((await req(ana, 'POST', `/api/orcamentos/${rasc}/aprovar`, {})).statusCode).toBe(409);

    const id = await orcamentoEnviado(ana, clienteAna);
    expect((await req(ana, 'GET', `/api/orcamentos/${id}`)).json().podeAprovar).toBe(true);
    const r = await req(ana, 'POST', `/api/orcamentos/${id}/aprovar`, {});
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json().pedido;
    expect(p.numero).toMatch(/^PED-\d{4}-0001$/);
    expect(p.status).toBe('CONFERENCIA_MEDIDAS');
    expect(p.valorTotal).toBe('5062.00');
    expect(p.previsaoEntrega).toBeNull();
    expect(p.custoPrevisto).toBeUndefined(); // vendedor sem "ver custos"
    expect(p.acoes).toEqual(expect.arrayContaining(['CONFERIR_SEM_ALTERACAO', 'ABRIR_ADITIVO']));
    expect(p.acoes).not.toContain('REGISTRAR_SINAL');
    // Orçamento ficou aprovado e não aceita mais edição nem segunda aprovação.
    const o = (await req(ana, 'GET', `/api/orcamentos/${id}`)).json();
    expect(o.orcamento.status).toBe('APROVADO');
    expect(o.orcamento.pedidoNumero).toBe(p.numero);
    expect((await req(ana, 'POST', `/api/orcamentos/${id}/aprovar`, {})).statusCode).toBe(409);
    // Cliente ganhou a data da última compra
    const { rows } = await pool.query('SELECT ultima_compra_em FROM clientes WHERE id = $1', [clienteAna]);
    expect(rows[0].ultima_compra_em).not.toBeNull();
    // Outro vendedor não vê
    expect((await req(beto, 'GET', `/api/pedidos/${p.id}`)).statusCode).toBe(404);
    expect((await req(beto, 'GET', '/api/pedidos')).json().pedidos).toHaveLength(0);
  });

  it('medidas conferidas: nasce aguardando sinal com previsão em 14 dias úteis', async () => {
    const id = await orcamentoEnviado(ana, clienteAna, true);
    const p = (await req(ana, 'POST', `/api/orcamentos/${id}/aprovar`, {})).json().pedido;
    expect(p.status).toBe('AGUARDANDO_SINAL');
    expect(p.previsaoEntrega).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Vendedor não libera compras
    expect((await req(ana, 'POST', `/api/pedidos/${p.id}/liberar-compras`, { semSinal: true })).statusCode).toBe(403);
  });
});

describe('fluxo completo: medição com aditivo, compras, produção, agenda e aceite', () => {
  let pedidoId: string;
  let ordens: { id: string; numero: string; fornecedorId: string | null; tipo: string; status: string; itens: { sku: string; quantidade: string }[] }[];

  it('conferência de medidas com aditivo: muda a medida, recalcula e registra a diferença', async () => {
    const id = await orcamentoEnviado(ana, clienteAna);
    pedidoId = (await req(ana, 'POST', `/api/orcamentos/${id}/aprovar`, {})).json().pedido.id;
    // Sem medição, não libera compras
    expect((await req(admin, 'POST', `/api/pedidos/${pedidoId}/liberar-compras`, { semSinal: true })).statusCode).toBe(409);

    const a = await req(ana, 'POST', `/api/pedidos/${pedidoId}/aditivo`, { motivo: 'Medição no local' });
    expect(a.statusCode, a.body).toBe(201);
    const rascId = a.json().orcamentoId;
    expect(a.json().pedido.aditivoAberto.tipo).toBe('CONFERENCIA_MEDIDAS');
    // O rascunho é editável no configurador, mas não pode ser "enviado" como orçamento comum.
    const doc = (await req(ana, 'GET', `/api/orcamentos/${rascId}`)).json();
    expect(doc.orcamento.editavel).toBe(true);
    expect(doc.orcamento.aditivo).toBe(true);
    expect(doc.transicoes).toEqual([]);
    expect((await req(ana, 'POST', `/api/orcamentos/${rascId}/status`, { status: 'ENVIADO' })).statusCode).toBe(409);
    // Segundo pedido de aditivo devolve o mesmo rascunho
    expect((await req(ana, 'POST', `/api/pedidos/${pedidoId}/aditivo`, {})).json().orcamentoId).toBe(rascId);

    // Medida real: persiana mais larga
    const o = doc.orcamento;
    const itens = o.itens.map((i: { id: string; ambiente: string; tipo: string; entrada: object; ajustes: object[] }) => ({
      id: i.id, ambiente: i.ambiente, tipo: i.tipo, ajustes: i.ajustes,
      entrada: i.tipo === 'PERSIANA' ? { ...persiana, medida: { tipo: 'PRODUCAO', largura: '1.80', altura: '1.00' } } : i.entrada,
    }));
    const s = await req(ana, 'PUT', `/api/orcamentos/${rascId}`, { clienteId: clienteAna, titulo: o.titulo, condicoes: o.condicoes, itens, atualizadoEmBase: o.atualizadoEm });
    expect(s.statusCode, s.body).toBe(200);
    const novoTotal = s.json().orcamento.totais.total;
    expect(Number(novoTotal)).toBeGreaterThan(5062);

    const c = await req(ana, 'POST', `/api/pedidos/${pedidoId}/aditivo/confirmar`, {});
    expect(c.statusCode, c.body).toBe(200);
    const p = c.json().pedido;
    expect(p.status).toBe('AGUARDANDO_SINAL');
    expect(p.valorTotal).toBe(novoTotal);
    expect(p.valorOriginal).toBe('5062.00');
    expect(p.orcamentoId).toBe(rascId);
    expect(p.aditivos[0]).toMatchObject({ status: 'CONFIRMADO', tipo: 'CONFERENCIA_MEDIDAS', valorAnterior: '5062.00', valorNovo: novoTotal });
    expect(c.json().resultado.avisos.join(' ')).toContain('passa a dever mais');
    expect(p.previsaoEntrega).toBeTruthy();
    // A versão do aditivo agora está aprovada e congelada
    expect((await req(ana, 'GET', `/api/orcamentos/${rascId}`)).json().orcamento.status).toBe('APROVADO');
  });

  it('sinal libera as compras e gera uma ordem por fornecedor (sem a instalação)', async () => {
    const r = await req(admin, 'POST', `/api/pedidos/${pedidoId}/liberar-compras`, { valor: '2.500,00', forma: 'PIX', recebidoEm: '2026-11-27' });
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json().pedido;
    expect(p.status).toBe('EM_COMPRA');
    expect(p.sinalValor).toBe('2500.00');
    ordens = p.compras;
    const porForn = new Map(ordens.map((o) => [o.fornecedorId, o]));
    expect(porForn.get(tecidos)?.tipo).toBe('COMPRA');
    expect(porForn.get(costureira)?.tipo).toBe('COSTURA');
    expect(porForn.get(fabrica)?.tipo).toBe('FABRICA');
    // Trilho/deslizantes sem fornecedor padrão ficam numa ordem "a definir"
    expect(porForn.has(null)).toBe(true);
    const skus = ordens.flatMap((o) => o.itens.map((i) => i.sku));
    expect(skus.some((s) => s.startsWith('SRV-'))).toBe(false);
    expect(skus).toEqual(expect.arrayContaining(['TEC-001', 'TEC-002', 'MDO-001', 'PER-001']));
    // Previsão do fornecedor de tecidos: 5 dias úteis
    expect((porForn.get(tecidos) as unknown as { previsaoEntrega: string }).previsaoEntrega).toMatch(/^\d{4}-/);
    expect(p.eventos.some((e: { acao: string }) => e.acao === 'COMPRAS_GERADAS')).toBe(true);
  });

  it('ordem sem fornecedor não é enviada; status do pedido acompanha as ordens', async () => {
    const semForn = ordens.find((o) => !o.fornecedorId)!;
    expect((await req(admin, 'POST', `/api/compras/${semForn.id}`, { acao: 'ENVIAR' })).statusCode).toBe(409);
    expect((await req(admin, 'POST', `/api/compras/${semForn.id}`, { acao: 'ENVIAR', fornecedorId: tecidos })).statusCode).toBe(200);
    for (const o of ordens.filter((x) => x.fornecedorId)) {
      expect((await req(admin, 'POST', `/api/compras/${o.id}`, { acao: 'ENVIAR' })).statusCode).toBe(200);
    }
    expect((await req(admin, 'GET', `/api/pedidos/${pedidoId}`)).json().pedido.status).toBe('EM_PRODUCAO');
    // Vendedor não mexe em compras
    expect((await req(ana, 'GET', '/api/compras')).statusCode).toBe(403);
    expect((await req(ana, 'GET', `/api/pedidos/${pedidoId}`)).json().pedido.compras).toEqual([]);
  });

  it('pré-agenda a instalação e, ao receber tudo, fica INSTALACAO_AGENDADA', async () => {
    const quando = new Date(Date.now() + 3 * 864e5).toISOString();
    expect((await req(admin, 'POST', `/api/pedidos/${pedidoId}/agendar`, { data: quando, instaladorId: costureira })).statusCode).toBe(400);
    const ag = await req(admin, 'POST', `/api/pedidos/${pedidoId}/agendar`, { data: quando, instaladorId: instalador, duracaoHoras: '3' });
    expect(ag.statusCode, ag.body).toBe(200);
    expect(ag.json().pedido.status).toBe('EM_PRODUCAO'); // ainda em produção: pré-agendado
    for (const o of ordens) {
      const r = await req(admin, 'POST', `/api/compras/${o.id}`, { acao: 'RECEBER', ...(o.fornecedorId === tecidos ? { custoReal: '600,00' } : {}) });
      expect(r.statusCode, r.body).toBe(200);
    }
    const p = (await req(admin, 'GET', `/api/pedidos/${pedidoId}`)).json().pedido;
    expect(p.status).toBe('INSTALACAO_AGENDADA');
    expect(p.instaladorNome).toBe('Zé Instalações');
    expect(Number(p.custoReal)).toBeGreaterThan(0);
    // Agenda do vendedor e pacote offline
    const agenda = (await req(ana, 'GET', '/api/instalacoes')).json();
    expect(agenda.agenda.map((x: { id: string }) => x.id)).toContain(pedidoId);
    const pacote = (await req(ana, 'GET', '/api/instalacoes/pacote-offline')).json();
    const inst = pacote.instalacoes.find((x: { id: string }) => x.id === pedidoId);
    expect(inst.obsAcesso).toBe('Portaria só até 17h');
    expect(inst.itens).toHaveLength(2);
    expect(inst.itens[0].pecas.some((x: { sku: string }) => x.sku.startsWith('TEC') || x.sku.startsWith('SRV') || x.sku.startsWith('MDO'))).toBe(false);
  });

  it('aditivo de alteração depois das compras gera ordem complementar e volta para compra', async () => {
    const a = (await req(ana, 'POST', `/api/pedidos/${pedidoId}/aditivo`, { motivo: 'Cliente quer bando na persiana maior' })).json();
    expect(a.pedido.aditivoAberto.tipo).toBe('ALTERACAO');
    const o = (await req(ana, 'GET', `/api/orcamentos/${a.orcamentoId}`)).json().orcamento;
    const itens = o.itens.map((i: { id: string; ambiente: string; tipo: string; entrada: Record<string, unknown>; ajustes: object[] }) => ({
      id: i.id, ambiente: i.ambiente, tipo: i.tipo, ajustes: i.ajustes,
      entrada: i.tipo === 'PERSIANA' ? { ...i.entrada, possuiGuiaLateral: true } : i.entrada,
    }));
    expect((await req(ana, 'PUT', `/api/orcamentos/${a.orcamentoId}`, { clienteId: clienteAna, condicoes: o.condicoes, itens, titulo: o.titulo })).statusCode).toBe(200);
    const c = await req(ana, 'POST', `/api/pedidos/${pedidoId}/aditivo/confirmar`, {});
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().resultado.ordensCriadas).toHaveLength(1);
    const p = (await req(admin, 'GET', `/api/pedidos/${pedidoId}`)).json().pedido;
    expect(p.status).toBe('EM_COMPRA');
    expect(p.instalacaoAgendada).toBeTruthy(); // continua pré-agendado
    const comp = p.compras.find((x: { aditivoNumero: number | null }) => x.aditivoNumero === 2);
    expect(comp.itens.map((i: { sku: string }) => i.sku)).toEqual(['ACP-002']);
    await req(admin, 'POST', `/api/compras/${comp.id}`, { acao: 'RECEBER' });
    expect((await req(admin, 'GET', `/api/pedidos/${pedidoId}`)).json().pedido.status).toBe('INSTALACAO_AGENDADA');
  });

  it('PDFs: ficha de corte, pedido de fábrica, ordem de compra e OS sem nenhum valor', async () => {
    const p = (await req(admin, 'GET', `/api/pedidos/${pedidoId}`)).json().pedido;
    for (const url of [`/api/pedidos/${pedidoId}/producao.pdf?tipo=CORTINA`, `/api/pedidos/${pedidoId}/producao.pdf?tipo=PERSIANA`,
      `/api/pedidos/${pedidoId}/os.pdf`, `/api/compras/${p.compras[0].id}/pdf`]) {
      const r = await req(admin, 'GET', url);
      expect(r.statusCode, url).toBe(200);
      expect(r.headers['content-type']).toBe('application/pdf');
      expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    }
    // Vendedor: OS sim, ficha de corte não
    expect((await req(ana, 'GET', `/api/pedidos/${pedidoId}/os.pdf`)).statusCode).toBe(200);
    expect((await req(ana, 'GET', `/api/pedidos/${pedidoId}/producao.pdf`)).statusCode).toBe(403);
    // Link público para o instalador (sem login) com WhatsApp
    const l = await req(ana, 'POST', `/api/pedidos/${pedidoId}/link-documento`, { tipo: 'OS_INSTALACAO', origem: 'https://sistema.exemplo.com' });
    expect(l.statusCode, l.body).toBe(201);
    expect(l.json().whatsapp).toContain('wa.me/5511912345678');
    const pub = await app.inject({ method: 'GET', url: l.json().caminho });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('application/pdf');
    expect((await req(ana, 'POST', `/api/pedidos/${pedidoId}/link-documento`, { tipo: 'FICHA_CORTE' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/documentos/tokeninvalidotokeninvalido' })).statusCode).toBe(404);
  });

  it('PDFs de produção não têm preço (texto extraído sem compressão)', async () => {
    const { pdfProducao, pdfOrdemServico } = await import('../src/pedidos/documentos.js');
    for (const pdf of [await pdfProducao(app.db, pedidoId, 'CORTINA'), await pdfProducao(app.db, pedidoId, 'PERSIANA'), await pdfOrdemServico(app.db, pedidoId)]) {
      expect(pdf!.length).toBeGreaterThan(1000);
    }
  });

  it('aceite digital: idempotente, conclui o pedido e avisa o saldo', async () => {
    const aceite = {
      id: randomUUID(), nomeRecebedor: 'João da Conceição', assinaturaPng: PNG,
      checklist: [{ itemId: null, descricao: 'Sala: cortina', ok: true }, { itemId: null, descricao: 'Quarto: persiana', ok: true }],
      assinadoEm: new Date().toISOString(), offline: true,
    };
    expect((await req(ana, 'POST', `/api/pedidos/${pedidoId}/aceite`, { ...aceite, assinaturaPng: 'data:image/png;base64,AAAA' + 'A'.repeat(60) })).statusCode).toBe(400);
    const r = await req(ana, 'POST', `/api/pedidos/${pedidoId}/aceite`, aceite);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().pedido.status).toBe('INSTALADO_CONCLUIDO');
    expect(r.json().avisos.join(' ')).toContain('Saldo a receber');
    // Reenvio da fila (mesmo id) não duplica nem dá erro
    const de2 = await req(ana, 'POST', `/api/pedidos/${pedidoId}/aceite`, aceite);
    expect(de2.statusCode).toBe(200);
    expect(de2.json().repetido).toBe(true);
    // Outro aceite para o mesmo pedido é recusado
    expect((await req(ana, 'POST', `/api/pedidos/${pedidoId}/aceite`, { ...aceite, id: randomUUID() })).statusCode).toBe(409);
    const { rows } = await pool.query('SELECT ultima_instalacao_em FROM clientes WHERE id = $1', [clienteAna]);
    expect(rows[0].ultima_instalacao_em).not.toBeNull();
    const termo = await req(ana, 'GET', `/api/pedidos/${pedidoId}/termo-aceite.pdf`);
    expect(termo.statusCode).toBe(200);
    // Concluído: sem aditivo nem cancelamento
    expect((await req(ana, 'POST', `/api/pedidos/${pedidoId}/aditivo`, {})).statusCode).toBe(409);
    expect((await req(admin, 'POST', `/api/pedidos/${pedidoId}/cancelar`, { motivo: 'teste' })).statusCode).toBe(409);
  });

  it('nota fiscal é só registrada; lista marca pedido concluído sem nota', async () => {
    let lista = (await req(admin, 'GET', '/api/pedidos')).json().pedidos;
    expect(lista.find((x: { id: string }) => x.id === pedidoId).semNota).toBe(true);
    expect((await req(admin, 'POST', `/api/pedidos/${pedidoId}/nota-fiscal`, { nfeChave: '123' })).statusCode).toBe(400);
    const r = await req(admin, 'POST', `/api/pedidos/${pedidoId}/nota-fiscal`, { nfeNumero: '1234', nfseNumero: '55' });
    expect(r.statusCode, r.body).toBe(200);
    lista = (await req(admin, 'GET', '/api/pedidos')).json().pedidos;
    expect(lista.find((x: { id: string }) => x.id === pedidoId).semNota).toBe(false);
    expect((await req(ana, 'POST', `/api/pedidos/${pedidoId}/nota-fiscal`, { nfeNumero: '1' })).statusCode).toBe(403);
  });
});

describe('descartar aditivo, trava de margem e cancelamento', () => {
  it('descartar apaga o rascunho e mantém o pedido como estava', async () => {
    const id = await orcamentoEnviado(ana, clienteAna, true);
    const p = (await req(ana, 'POST', `/api/orcamentos/${id}/aprovar`, {})).json().pedido;
    const a = (await req(ana, 'POST', `/api/pedidos/${p.id}/aditivo`, {})).json();
    const d = await req(ana, 'POST', `/api/pedidos/${p.id}/aditivo/descartar`, {});
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().pedido.aditivoAberto).toBeNull();
    expect(d.json().pedido.aditivos[0].status).toBe('DESCARTADO');
    expect((await req(ana, 'GET', `/api/orcamentos/${a.orcamentoId}`)).statusCode).toBe(404);
    expect(d.json().pedido.orcamentoId).toBe(id);
  });

  it('aditivo com desconto acima do limite do vendedor exige o administrador', async () => {
    const id = await orcamentoEnviado(ana, clienteAna, true);
    const p = (await req(ana, 'POST', `/api/orcamentos/${id}/aprovar`, {})).json().pedido;
    const a = (await req(ana, 'POST', `/api/pedidos/${p.id}/aditivo`, {})).json();
    const o = (await req(ana, 'GET', `/api/orcamentos/${a.orcamentoId}`)).json().orcamento;
    await req(ana, 'PUT', `/api/orcamentos/${a.orcamentoId}`, {
      clienteId: clienteAna, titulo: o.titulo, condicoes: { ...o.condicoes, descontoValor: '30' },
      itens: o.itens.map((i: { id: string; ambiente: string; tipo: string; entrada: object; ajustes: object[] }) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, entrada: i.entrada, ajustes: i.ajustes })),
    });
    const c = await req(ana, 'POST', `/api/pedidos/${p.id}/aditivo/confirmar`, {});
    expect(c.statusCode).toBe(409);
    expect(c.json().exigeLiberacao).toBe(true);
    // Admin libera no rascunho (mesma tela de liberação do orçamento) e o vendedor confirma
    expect((await req(ana, 'POST', `/api/orcamentos/${a.orcamentoId}/liberar`, { email: 'admin@loja.com', senha: 'Senha123' })).statusCode).toBe(200);
    const c2 = await req(ana, 'POST', `/api/pedidos/${p.id}/aditivo/confirmar`, {});
    expect(c2.statusCode, c2.body).toBe(200);
    expect(c2.json().resultado.avisos.join(' ')).toContain('caiu');
  });

  it('cancelar pedido cancela as ordens abertas', async () => {
    const id = await orcamentoEnviado(ana, clienteAna, true);
    const p = (await req(ana, 'POST', `/api/orcamentos/${id}/aprovar`, {})).json().pedido;
    await req(admin, 'POST', `/api/pedidos/${p.id}/liberar-compras`, { semSinal: true, motivo: 'cliente antigo' });
    expect((await req(ana, 'POST', `/api/pedidos/${p.id}/cancelar`, { motivo: 'desistiu' })).statusCode).toBe(403);
    const r = await req(admin, 'POST', `/api/pedidos/${p.id}/cancelar`, { motivo: 'Cliente desistiu' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().pedido.status).toBe('CANCELADO');
    expect(r.json().pedido.compras.every((o: { status: string }) => o.status === 'CANCELADA')).toBe(true);
    expect(r.json().pedido.liberadoSemSinal).toBe(true);
  });
});
