import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar } from './ajuda.js';
import { hojeLoja, somarDiasUteis } from '../src/pedidos/dias-uteis.js';

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, ana: string, beto: string;
let anaId: string, betoId: string;
let clienteAna: string, clienteBeto: string;

const cortina = {
  larguraTrilho: '3.00', alturaPronta: '2.60', numFolhas: 2, confeccao: 'WAVE',
  tecido: { sku: 'TEC-001', fator: '2.5', margemBarra: '0.30' },
  skus: { trilho: 'TRI-002' },
};
const persiana = {
  sku: 'PER-001', medida: { tipo: 'PRODUCAO', largura: '1.40', altura: '1.00' },
  acionamento: 'MANUAL', ladoComando: 'DIREITO', sentidoEnrolamento: 'NORMAL',
};
// JPEG mínimo (só os bytes; o servidor não decodifica)
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from('ffd8ffe000104a46494600', 'hex'), Buffer.alloc(300, 7), Buffer.from('ffd9', 'hex')]).toString('base64');

async function req(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

async function orcamentoEnviado(cookie: string, clienteId: string) {
  const id = randomUUID();
  const r = await req(cookie, 'PUT', `/api/orcamentos/${id}`, {
    clienteId, titulo: 'Casa',
    condicoes: { descontoTipo: 'PERCENTUAL', descontoValor: '0', acrescimo: '0', parcelas: 1, formaPagamento: 'PIX' },
    itens: [
      { id: randomUUID(), ambiente: 'Sala', tipo: 'CORTINA', entrada: cortina, ajustes: [] },
      { id: randomUUID(), ambiente: 'Quarto', tipo: 'PERSIANA', entrada: persiana, ajustes: [] },
    ],
  });
  expect(r.statusCode, r.body).toBe(200);
  expect((await req(cookie, 'POST', `/api/orcamentos/${id}/status`, { status: 'ENVIADO' })).statusCode).toBe(200);
  return id;
}

const amanha = (hora = 10) => {
  const d = new Date(Date.now() + 864e5);
  d.setUTCHours(hora + 3, 0, 0, 0); // hora de Brasília
  return d.toISOString();
};

const vaos = [
  { id: 'v1', ambiente: 'Sala', descricao: 'Janela grande', tipo: 'CORTINA', larguras: ['3.10'], alturas: ['2.58'], profundidadeCortineiroM: '0.15' },
  { id: 'v2', ambiente: 'Quarto', descricao: 'Janela', tipo: 'PERSIANA', modo: 'DENTRO_VAO', larguras: ['1.42', '1.41', '1.43'], alturas: ['1.02', '1.01'], ladoComando: 'ESQUERDO' },
];

async function agendar(cookie: string, corpo: object) {
  const r = await req(cookie, 'POST', '/api/medicoes', { dataAgendada: amanha(), ...corpo });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().medicao;
}

async function registrar(cookie: string, id: string, extra: object = {}) {
  const r = await req(cookie, 'POST', `/api/medicoes/${id}/registro`, {
    registroId: randomUUID(), vaos, obsCampo: 'Tomada perto da janela da sala', realizadaEm: new Date().toISOString(), ...extra,
  });
  return r;
}

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  anaId = await criarUsuario(pool, { email: 'ana@loja.com', perfil: 'VENDEDOR' });
  betoId = await criarUsuario(pool, { email: 'beto@loja.com', perfil: 'VENDEDOR' });
  app = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  ana = await entrar(app, 'ana@loja.com');
  beto = await entrar(app, 'beto@loja.com');
  clienteAna = (await req(ana, 'POST', '/api/clientes', { nomeCompleto: 'Maria Souza', telefoneWhatsapp: '11 98765-4321', logradouro: 'Rua A', numero: '10', cidade: 'São Paulo', uf: 'SP' })).json().cliente.id;
  clienteBeto = (await req(beto, 'POST', '/api/clientes', { nomeCompleto: 'Carlos Lima', telefoneWhatsapp: '11 98888-1111' })).json().cliente.id;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('agendar', () => {
  it('vendedor agenda para cliente dele; proposta enviada vira "Aguardando medição"', async () => {
    const orc = await orcamentoEnviado(ana, clienteAna);
    const proj = (await req(ana, 'GET', `/api/clientes/${clienteAna}/projetos`)).json().projetos;
    expect(proj.map((p: { orcamentoId: string }) => p.orcamentoId)).toContain(orc);

    const m = await agendar(ana, { clienteId: clienteAna, orcamentoId: orc, duracaoHoras: '1,5', responsavelId: betoId });
    expect(m.numero).toMatch(/^MED-\d{4}-0001$/);
    expect(m.status).toBe('AGENDADA');
    expect(m.responsavelId).toBe(anaId); // vendedor não escolhe outro responsável
    expect(m.duracaoHoras).toBe('1.5');
    expect(m.endereco).toContain('Rua A 10');
    expect(m.itens).toHaveLength(2);
    expect((await req(ana, 'GET', `/api/orcamentos/${orc}`)).json().orcamento.status).toBe('AGUARDANDO_MEDICAO');
    // Outro vendedor não vê nem agenda para cliente que não é dele
    expect((await req(beto, 'GET', `/api/medicoes/${m.id}`)).statusCode).toBe(404);
    expect((await req(beto, 'POST', '/api/medicoes', { clienteId: clienteAna, dataAgendada: amanha() })).statusCode).toBe(404);
    expect((await req(beto, 'POST', '/api/medicoes', { clienteId: clienteBeto, orcamentoId: orc, dataAgendada: amanha() })).statusCode).toBe(404);
  });

  it('admin escolhe o responsável e recebe aviso de horário apertado', async () => {
    const a = await agendar(admin, { clienteId: clienteBeto, responsavelId: betoId });
    expect(a.responsavelId).toBe(betoId);
    const r = await req(admin, 'POST', '/api/medicoes', { clienteId: clienteBeto, responsavelId: betoId, dataAgendada: amanha(11) });
    expect(r.statusCode).toBe(201);
    expect(r.json().avisos[0]).toMatch(/beto já tem 1 compromisso/);
    // Beto vê as dele na agenda; Ana não vê as de Beto
    const ag = (await req(beto, 'GET', '/api/agenda')).json();
    expect(ag.medicoes).toHaveLength(2);
    expect((await req(ana, 'GET', '/api/agenda')).json().medicoes.every((x: { responsavelNome: string }) => x.responsavelNome === 'ana')).toBe(true);
    // Admin filtra por responsável
    expect((await req(admin, 'GET', `/api/agenda?responsavel=${betoId}`)).json().medicoes).toHaveLength(2);
    // Remarcar e cancelar
    const rm = await req(beto, 'POST', `/api/medicoes/${a.id}/remarcar`, { dataAgendada: amanha(15), responsavelId: anaId });
    expect(rm.statusCode, rm.body).toBe(200);
    expect(rm.json().medicao.responsavelId).toBe(betoId); // vendedor não passa a visita para outro
    expect((await req(beto, 'POST', `/api/medicoes/${a.id}/cancelar`, { motivo: 'x' })).statusCode).toBe(400);
    const c = await req(beto, 'POST', `/api/medicoes/${a.id}/cancelar`, { motivo: 'Cliente viajou' });
    expect(c.json().medicao.status).toBe('CANCELADA');
    expect((await registrar(beto, a.id)).statusCode).toBe(409);
  });

  it('valida data e medidas (erro de 100x)', async () => {
    expect((await req(ana, 'POST', '/api/medicoes', { clienteId: clienteAna, dataAgendada: '2026-12-01' })).statusCode).toBe(400);
    const m = await agendar(ana, { clienteId: clienteAna });
    const r = await registrar(ana, m.id, { vaos: [{ ...vaos[0], larguras: ['310'] }] });
    expect(r.statusCode).toBe(400);
    expect(r.json().erro).toMatch(/centímetros/);
    await req(ana, 'POST', `/api/medicoes/${m.id}/cancelar`, { motivo: 'teste de validação' });
  });
});

describe('registro na obra e conferência', () => {
  it('orçamento: registro (idempotente), fotos, conferência com alteração gera a v2 com medidas conferidas', async () => {
    const orc = await orcamentoEnviado(ana, clienteAna);
    const m = await agendar(ana, { clienteId: clienteAna, orcamentoId: orc });
    expect((await req(ana, 'POST', `/api/medicoes/${m.id}/conferir`, { alterou: false })).statusCode).toBe(409); // ainda não mediu

    const registroId = randomUUID();
    const r1 = await registrar(ana, m.id, { registroId, offline: true });
    expect(r1.statusCode, r1.body).toBe(201);
    const med = r1.json().medicao;
    expect(med.status).toBe('REALIZADA');
    expect(med.registradoOffline).toBe(true);
    expect(med.vaos[1]).toMatchObject({ modo: 'DENTRO_VAO', larguras: ['1.42', '1.41', '1.43'], ladoComando: 'ESQUERDO' });
    expect(med.conferencia).toMatchObject({ pode: true, destino: 'ORCAMENTO' });
    // Reenvio da fila do aparelho não muda nada
    expect((await registrar(ana, m.id, { registroId })).statusCode).toBe(200);

    // Fotos (uma por chamada, id do aparelho)
    const fotoId = randomUUID();
    const f1 = await req(ana, 'POST', `/api/medicoes/${m.id}/fotos`, { id: fotoId, vaoId: 'v1', legenda: 'Sala', dataUrl: JPEG });
    expect(f1.statusCode, f1.body).toBe(201);
    expect((await req(ana, 'POST', `/api/medicoes/${m.id}/fotos`, { id: fotoId, vaoId: 'v1', dataUrl: JPEG })).statusCode).toBe(200);
    expect((await req(ana, 'POST', `/api/medicoes/${m.id}/fotos`, { id: randomUUID(), dataUrl: 'data:text/html;base64,AAAA' })).statusCode).toBe(400);
    const foto = await req(ana, 'GET', `/api/medicoes/fotos/${fotoId}`);
    expect(foto.statusCode).toBe(200);
    expect(foto.headers['content-type']).toBe('image/jpeg');
    expect((await req(beto, 'GET', `/api/medicoes/fotos/${fotoId}`)).statusCode).toBe(404);
    expect((await req(ana, 'GET', `/api/medicoes/${m.id}`)).json().medicao.fotos).toHaveLength(1);

    // Agenda mostra a pendência de conferência
    expect((await req(ana, 'GET', '/api/agenda')).json().pendencias.aConferir.map((x: { id: string }) => x.id)).toContain(m.id);

    const c = await req(ana, 'POST', `/api/medicoes/${m.id}/conferir`, { alterou: true });
    expect(c.statusCode, c.body).toBe(200);
    const res = c.json();
    expect(res.medicao.status).toBe('CONFERIDA');
    expect(res.resultado.orcamentoId).not.toBe(orc);
    const v2 = (await req(ana, 'GET', `/api/orcamentos/${res.resultado.orcamentoId}`)).json().orcamento;
    expect(v2.versao).toBe(2);
    expect(v2.status).toBe('RASCUNHO');
    expect(v2.condicoes.medidasConferidas).toBe(true);
    expect((await req(ana, 'GET', `/api/orcamentos/${orc}`)).json().orcamento.status).toBe('EM_NEGOCIACAO');
    // O configurador da v2 enxerga as medidas da obra
    const ms = (await req(ana, 'GET', `/api/orcamentos/${v2.id}/medicoes`)).json().medicoes;
    expect(ms).toHaveLength(1);
    expect(ms[0].vaos).toHaveLength(2);
    expect(ms[0].fotos).toHaveLength(1);
    // Conferida: não aceita novo registro nem conferir de novo
    expect((await registrar(ana, m.id)).statusCode).toBe(409);
    expect((await req(ana, 'POST', `/api/medicoes/${m.id}/conferir`, { alterou: false })).statusCode).toBe(409);
  });

  it('pedido em conferência de medidas: conferir sem alteração libera e a previsão conta de hoje', async () => {
    const orc = await orcamentoEnviado(ana, clienteAna);
    const ap = await req(ana, 'POST', `/api/orcamentos/${orc}/aprovar`, {});
    expect(ap.statusCode, ap.body).toBe(201);
    const pedido = ap.json().pedido;
    expect(pedido.status).toBe('CONFERENCIA_MEDIDAS');
    // Pendência "sem visita" aparece na agenda
    expect((await req(ana, 'GET', '/api/agenda')).json().pendencias.semVisita.map((x: { id: string }) => x.id)).toContain(pedido.id);

    const m = await agendar(ana, { clienteId: clienteAna, orcamentoId: orc });
    expect(m.pedidoNumero).toBe(pedido.numero);
    expect((await req(ana, 'GET', '/api/agenda')).json().pendencias.semVisita.map((x: { id: string }) => x.id)).not.toContain(pedido.id);
    expect((await registrar(ana, m.id)).statusCode).toBe(201);
    const c = await req(ana, 'POST', `/api/medicoes/${m.id}/conferir`, { alterou: false });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().medicao.status).toBe('CONFERIDA');
    const p = (await req(ana, 'GET', `/api/pedidos/${pedido.id}`)).json().pedido;
    expect(p.status).toBe('AGUARDANDO_SINAL');
    expect(p.previsaoEntrega).toBe(somarDiasUteis(hojeLoja(), 14));
  });

  it('pedido com medida diferente: abre aditivo; confirmar o aditivo marca a medição conferida', async () => {
    const orc = await orcamentoEnviado(ana, clienteAna);
    const pedido = (await req(ana, 'POST', `/api/orcamentos/${orc}/aprovar`, {})).json().pedido;
    const m = await agendar(ana, { clienteId: clienteAna, orcamentoId: orc });
    await registrar(ana, m.id);
    const c = await req(ana, 'POST', `/api/medicoes/${m.id}/conferir`, { alterou: true });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().medicao.status).toBe('REALIZADA'); // só conta quando o aditivo for confirmado
    const aditivo = c.json().resultado.orcamentoId;
    expect(aditivo).toBeTruthy();
    expect((await req(ana, 'GET', `/api/pedidos/${pedido.id}`)).json().pedido.status).toBe('CONFERENCIA_MEDIDAS');
    const conf = await req(ana, 'POST', `/api/pedidos/${pedido.id}/aditivo/confirmar`, {});
    expect(conf.statusCode, conf.body).toBe(200);
    expect(conf.json().pedido.status).toBe('AGUARDANDO_SINAL');
    expect((await req(ana, 'GET', `/api/medicoes/${m.id}`)).json().medicao.status).toBe('CONFERIDA');
  });

  it('sem orçamento: conferida fica registrada e aparece no orçamento criado depois', async () => {
    const m = await agendar(beto, { clienteId: clienteBeto });
    await registrar(beto, m.id);
    const c = await req(beto, 'POST', `/api/medicoes/${m.id}/conferir`, { alterou: false });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().medicao.status).toBe('CONFERIDA');
    const orc = await orcamentoEnviado(beto, clienteBeto);
    expect((await req(beto, 'GET', `/api/orcamentos/${orc}/medicoes`)).json().medicoes).toHaveLength(1);
  });

  it('pacote offline traz as visitas do responsável com os itens', async () => {
    const r = (await req(ana, 'GET', '/api/medicoes/pacote-offline')).json();
    expect(r.medicoes.length).toBeGreaterThan(0);
    expect(r.medicoes.every((x: { responsavelId: string }) => x.responsavelId === anaId)).toBe(true);
    expect(r.medicoes.some((x: { itens: unknown[] }) => x.itens.length > 0)).toBe(true);
  });
});
