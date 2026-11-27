import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { alertasDisponibilidade, criarCatalogo } from '@sistema/motor-calculo';
import { appTeste, bancoLimpo, criarUsuario, entrar } from './ajuda.js';
import { montarProposta } from '../src/orcamentos/proposta.js';
import { lerData, lerStatus } from '../src/catalogo/importacao.js';

/** Status de disponibilidade do produto (Gabriel, 27/11/2026). */

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, ana: string, cliente: string;

const req = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const idDe = async (sku: string) => (await pool.query('SELECT id FROM produtos WHERE sku = $1', [sku])).rows[0].id as string;
const persiana = {
  sku: 'PER-001', medida: { tipo: 'PRODUCAO', largura: '1.40', altura: '1.00' },
  acionamento: 'MANUAL', ladoComando: 'DIREITO', sentidoEnrolamento: 'NORMAL',
};

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  await criarUsuario(pool, { email: 'ana@loja.com', perfil: 'VENDEDOR' });
  app = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  ana = await entrar(app, 'ana@loja.com');
  cliente = (await req(ana, 'POST', '/api/clientes', { nomeCompleto: 'João Teste', telefoneWhatsapp: '11 98765-0000' })).json().cliente.id;
});
afterAll(async () => { await app.close(); await pool.end(); });

async function status(sku: string, disponibilidade: string, previsaoDisponivel?: string) {
  return req(admin, 'PATCH', `/api/catalogo/produtos/${await idDe(sku)}`, { disponibilidade, previsaoDisponivel });
}
async function orcamento(cookie = ana) {
  const id = randomUUID();
  const r = await req(cookie, 'PUT', `/api/orcamentos/${id}`, {
    clienteId: cliente, titulo: 'Teste', itens: [{ id: randomUUID(), ambiente: 'Quarto', tipo: 'PERSIANA', entrada: persiana, ajustes: [] }],
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().orcamento as { id: string; itens: { alertas: { codigo: string; severidade: string; mensagem: string }[] }[] };
}

describe('status de disponibilidade', () => {
  it('produto novo nasce Disponível; em falta com previsão exige a data; outro status limpa a data', async () => {
    const lista = (await req(ana, 'GET', '/api/catalogo/produtos')).json().produtos as { sku: string; disponibilidade: string }[];
    expect(lista.every((p) => p.disponibilidade === 'DISPONIVEL')).toBe(true);
    expect((await status('PER-001', 'EM_FALTA_COM_PREVISAO')).statusCode).toBe(400);
    expect((await status('PER-001', 'QUALQUER')).statusCode).toBe(400);
    expect((await status('PER-001', 'EM_FALTA_COM_PREVISAO', '2026-12-10')).statusCode).toBe(200);
    const p = (await req(ana, 'GET', '/api/catalogo/produtos')).json().produtos.find((x: { sku: string }) => x.sku === 'PER-001');
    expect(p).toMatchObject({ disponibilidade: 'EM_FALTA_COM_PREVISAO', previsaoDisponivel: '2026-12-10' });
  });

  it('em falta: alerta para o vendedor com a previsão, e nada disso vai para o PDF', async () => {
    const o = await orcamento();
    const a = o.itens[0]!.alertas.find((x) => x.codigo === 'PRODUTO_EM_FALTA');
    expect(a?.mensagem).toContain('10/12/2026');
    const pdf = JSON.stringify(await montarProposta(app.db, o.id, true));
    expect(pdf).not.toMatch(/falta|previs/i);
    // Em falta não impede o envio.
    expect((await req(ana, 'POST', `/api/orcamentos/${o.id}/status`, { status: 'ENVIADO' })).statusCode).toBe(200);
  });

  it('fora de linha: alerta crítico e ninguém envia', async () => {
    expect((await status('PER-001', 'FORA_DE_LINHA', '2026-12-10')).statusCode).toBe(200);
    expect((await pool.query(`SELECT previsao_disponivel FROM produtos WHERE sku = 'PER-001'`)).rows[0].previsao_disponivel).toBeNull();
    const o = await orcamento();
    expect(o.itens[0]!.alertas.find((x) => x.codigo === 'PRODUTO_FORA_DE_LINHA')?.severidade).toBe('CRITICO');
    for (const quem of [ana, admin]) {
      const r = await req(quem, 'POST', `/api/orcamentos/${o.id}/status`, { status: 'ENVIADO' });
      expect(r.statusCode).toBe(409);
      expect(r.json().erro).toContain('fora de linha');
    }
  });

  it('sob consulta: vendedor não envia, administrador envia', async () => {
    await status('PER-001', 'SOB_CONSULTA');
    const o = await orcamento();
    expect(o.itens[0]!.alertas.some((x) => x.codigo === 'PRODUTO_SOB_CONSULTA')).toBe(true);
    const r = await req(ana, 'POST', `/api/orcamentos/${o.id}/status`, { status: 'ENVIADO' });
    expect(r.statusCode).toBe(409);
    expect(r.json().erro).toContain('administrador');
    expect((await req(admin, 'POST', `/api/orcamentos/${o.id}/status`, { status: 'ENVIADO' })).statusCode).toBe(200);
  });

  it('importação: colunas Status e Previsão', async () => {
    const csv = ['SKU;Status;Previsão', 'PER-001;Disponível;', 'PER-002;Em falta;15/01/2027', 'PER-003;Fora de linha;', 'TEC-001;Em falta;', 'TEC-002;Pronto;'].join('\n');
    const r = await req(admin, 'POST', '/api/catalogo/importacao/aplicar', { arquivo: 's.csv', conteudo: Buffer.from(csv).toString('base64') });
    expect(r.statusCode, r.body).toBe(201);
    const it = (sku: string) => (r.json().previa.itens as { sku: string; mudancas: string[]; erros: string[] }[]).find((i) => i.sku === sku)!;
    expect(it('PER-002').mudancas).toEqual(['Previsão: (vazio) → 15/01/2027', 'Status: Disponível → Em falta com previsão']);
    expect(it('TEC-002').erros.join()).toContain('Status "Pronto" inválido');
    const linhas = (await pool.query(`SELECT sku, disponibilidade, previsao_disponivel::text AS p FROM produtos WHERE sku IN ('PER-001','PER-002','PER-003','TEC-001') ORDER BY sku`)).rows;
    expect(linhas).toEqual([
      { sku: 'PER-001', disponibilidade: 'DISPONIVEL', p: null },
      { sku: 'PER-002', disponibilidade: 'EM_FALTA_COM_PREVISAO', p: '2027-01-15' },
      { sku: 'PER-003', disponibilidade: 'FORA_DE_LINHA', p: null },
      { sku: 'TEC-001', disponibilidade: 'EM_FALTA_SEM_PREVISAO', p: null },
    ]);
  });

  it('leitura de status e datas da planilha', () => {
    expect(lerStatus('em falta', false)).toBe('EM_FALTA_SEM_PREVISAO');
    expect(lerStatus('Em Falta', true)).toBe('EM_FALTA_COM_PREVISAO');
    expect(lerStatus('Em falta sem previsão', true)).toBe('EM_FALTA_SEM_PREVISAO');
    expect(lerStatus('SOB CONSULTA', false)).toBe('SOB_CONSULTA');
    expect(lerData({ texto: '10/12/26', numero: false })).toBe('2026-12-10');
    expect(lerData({ texto: '46366', numero: true })).toBe('2026-12-10');
    expect(lerData({ texto: '31/02/2026', numero: false })).toBeNull();
  });

  it('alerta da previsão vencida', () => {
    const cat = criarCatalogo([{ sku: 'X', nome: 'Tela', unidade: 'M2', custoUnitario: 1, precoVendaUnitario: 2, disponibilidade: { status: 'EM_FALTA_COM_PREVISAO', previsao: '2026-01-01' } }]);
    expect(alertasDisponibilidade(['X'], cat, '2026-11-27')[0]!.mensagem).toContain('já passou');
  });
});
