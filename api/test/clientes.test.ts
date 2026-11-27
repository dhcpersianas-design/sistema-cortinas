import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar, LOJA } from './ajuda.js';

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, ana: string, beto: string;
let idAna: string, idBeto: string;

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  idAna = await criarUsuario(pool, { email: 'ana@loja.com', perfil: 'VENDEDOR' });
  idBeto = await criarUsuario(pool, { email: 'beto@loja.com', perfil: 'VENDEDOR' });
  app = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  ana = await entrar(app, 'ana@loja.com');
  beto = await entrar(app, 'beto@loja.com');
});
afterAll(async () => { await app.close(); await pool.end(); });

const req = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, payload });

const joao = {
  nomeCompleto: 'João da Conceição', telefoneWhatsapp: '(11) 98765-4321', documento: '529.982.247-25',
  email: 'Joao@Email.com', cep: '01310100', logradouro: 'Av. Paulista', numero: '1000', bairro: 'Bela Vista',
  cidade: 'São Paulo', uf: 'sp',
};

describe('CRM de clientes', () => {
  let idJoao: string;

  it('vendedor cadastra: telefone +55, CPF só dígitos, vira responsável, link WhatsApp', async () => {
    const r = await req(ana, 'POST', '/api/clientes', joao);
    expect(r.statusCode).toBe(201);
    const c = r.json().cliente;
    idJoao = c.id;
    expect(c.telefoneWhatsapp).toBe('+5511987654321');
    expect(c.telefoneFormatado).toBe('(11) 98765-4321');
    expect(c.whatsappLink).toBe('https://wa.me/5511987654321');
    expect(c.cpfCnpj).toBe('52998224725');
    expect(c.cpfCnpjFormatado).toBe('529.982.247-25');
    expect(c.tipoPessoa).toBe('PF');
    expect(c.email).toBe('joao@email.com');
    expect(c.cep).toBe('01310-100');
    expect(c.uf).toBe('SP');
    expect(c.vendedorResponsavelId).toBe(idAna);
    expect(c.vendedorResponsavelNome).toBe('ana');
  });

  it('valida telefone, CPF e UF', async () => {
    expect((await req(ana, 'POST', '/api/clientes', { ...joao, documento: null, telefoneWhatsapp: '1234' })).json().erro).toMatch(/Telefone inválido/);
    expect((await req(ana, 'POST', '/api/clientes', { ...joao, documento: '111.111.111-11' })).json().erro).toMatch(/CPF\/CNPJ inválido/);
    expect((await req(ana, 'POST', '/api/clientes', { ...joao, documento: null, uf: 'XX' })).json().erro).toMatch(/UF/);
  });

  it('busca tolerante a acentos e por partes do nome, telefone, CPF e cidade', async () => {
    for (const q of ['joao', 'JOÃO', 'conceicao', 'Concei', 'joao da', '98765', '5299822', 'sao paulo']) {
      const lista = (await req(ana, 'GET', `/api/clientes?q=${encodeURIComponent(q)}`)).json().clientes;
      expect(lista.map((c: { id: string }) => c.id), q).toContain(idJoao);
    }
    expect((await req(ana, 'GET', '/api/clientes?q=maria')).json().clientes).toHaveLength(0);
  });

  it('busca tolera erro de digitação (trigrama)', async () => {
    const lista = (await req(ana, 'GET', '/api/clientes?q=Joao%20Concesao')).json().clientes;
    expect(lista[0]?.id).toBe(idJoao);
  });

  it('vendedor só vê os próprios clientes; ADMIN vê todos', async () => {
    await req(beto, 'POST', '/api/clientes', { nomeCompleto: 'Maria Souza', telefoneWhatsapp: '21 99999-0000' });
    const deBeto = (await req(beto, 'GET', '/api/clientes')).json().clientes.map((c: { nomeCompleto: string }) => c.nomeCompleto);
    expect(deBeto).toEqual(['Maria Souza']);
    expect((await req(beto, 'GET', `/api/clientes/${idJoao}`)).statusCode).toBe(404);
    expect((await req(beto, 'PATCH', `/api/clientes/${idJoao}`, { email: 'x@y.com' })).statusCode).toBe(404);
    expect((await req(admin, 'GET', '/api/clientes')).json().clientes).toHaveLength(2);
  });

  it('CPF repetido: avisa sem expor o cliente de outro vendedor', async () => {
    const r = await req(beto, 'POST', '/api/clientes', { ...joao, nomeCompleto: 'Outro', telefoneWhatsapp: '11 93333-4444' });
    expect(r.statusCode).toBe(409);
    expect(r.json().erro).toMatch(/outro vendedor/);
    expect(r.json().clienteId).toBeUndefined();
    const r2 = await req(ana, 'POST', '/api/clientes', { ...joao, nomeCompleto: 'Outro', telefoneWhatsapp: '11 93333-4444' });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().clienteId).toBe(idJoao);
  });

  it('WhatsApp repetido bloqueia, como o CPF (mesmo escrito de outro jeito)', async () => {
    const r = await req(ana, 'POST', '/api/clientes', { nomeCompleto: 'Esposa do João', telefoneWhatsapp: '+55 (11) 98765-4321' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ erro: 'Já existe cliente com este WhatsApp.', clienteId: idJoao });
    const r2 = await req(beto, 'POST', '/api/clientes', { nomeCompleto: 'Outro', telefoneWhatsapp: '11987654321' });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().erro).toMatch(/outro vendedor/);
    expect(r2.json().clienteId).toBeUndefined();
    // Editar outro cliente para o mesmo WhatsApp também é recusado
    const { clientes: [maria] } = (await req(beto, 'GET', '/api/clientes?q=maria')).json();
    expect((await req(beto, 'PATCH', `/api/clientes/${maria.id}`, { telefoneWhatsapp: '11987654321' })).statusCode).toBe(409);
  });

  it('reenvio offline com o mesmo UUID não duplica', async () => {
    const id = randomUUID();
    const corpo = { id, nomeCompleto: 'Cliente da Obra', telefoneWhatsapp: '11 91111-2222' };
    expect((await req(ana, 'POST', '/api/clientes', corpo)).statusCode).toBe(201);
    const r = await req(ana, 'POST', '/api/clientes', corpo);
    expect(r.statusCode).toBe(200);
    expect(r.json().jaExistia).toBe(true);
    expect((await req(beto, 'POST', '/api/clientes', corpo)).statusCode).toBe(409);
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM clientes WHERE id = $1', [id]);
    expect(rows[0].n).toBe(1);
  });

  it('edição: limpa campo com "" e detecta conflito pelo atualizadoEm', async () => {
    const { cliente } = (await req(ana, 'GET', `/api/clientes/${idJoao}`)).json();
    const r1 = await req(ana, 'PATCH', `/api/clientes/${idJoao}`, { complemento: 'Apto 12', atualizadoEmBase: cliente.atualizadoEm });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().cliente.complemento).toBe('Apto 12');
    expect(r1.json().cliente.email).toBe('joao@email.com'); // campo não enviado fica como estava
    // Outro aparelho ainda com a versão antiga: não sobrescreve.
    const r2 = await req(ana, 'PATCH', `/api/clientes/${idJoao}`, { complemento: 'Casa', atualizadoEmBase: cliente.atualizadoEm });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().conflito).toBe(true);
    expect(r2.json().cliente.complemento).toBe('Apto 12');
    const r3 = await req(ana, 'PATCH', `/api/clientes/${idJoao}`, { complemento: '' });
    expect(r3.json().cliente.complemento).toBeNull();
  });

  it('só ADMIN transfere ou inativa', async () => {
    expect((await req(ana, 'PATCH', `/api/clientes/${idJoao}`, { vendedorResponsavelId: idBeto })).statusCode).toBe(403);
    expect((await req(ana, 'PATCH', `/api/clientes/${idJoao}`, { ativo: false })).statusCode).toBe(403);
    expect((await req(ana, 'POST', '/api/clientes', { nomeCompleto: 'X Y', telefoneWhatsapp: '11 92222-3333', vendedorResponsavelId: idBeto })).statusCode).toBe(403);
    const r = await req(admin, 'PATCH', `/api/clientes/${idJoao}`, { vendedorResponsavelId: idBeto });
    expect(r.statusCode).toBe(200);
    expect((await req(beto, 'GET', `/api/clientes/${idJoao}`)).statusCode).toBe(200);
    expect((await req(ana, 'GET', `/api/clientes/${idJoao}`)).statusCode).toBe(404);
    await req(admin, 'PATCH', `/api/clientes/${idJoao}`, { vendedorResponsavelId: idAna });
  });

  it('histórico de compras e instalações e busca por produto comprado', async () => {
    const { rows: [o] } = await pool.query(
      `INSERT INTO orcamentos (loja_id, codigo_sequencial, cliente_id, vendedor_id, status, valor_total_venda)
       VALUES ($1, 'ORC-0001', $2, $3, 'APROVADO', 2745.40) RETURNING id`, [LOJA, idJoao, idAna]);
    await pool.query(
      `INSERT INTO orcamento_itens_compostos (orcamento_id, ambiente, tipo_item, descricao_comercial, largura_producao_m, altura_producao_m)
       VALUES ($1, 'Sala', 'CORTINA', 'Cortina Wave em Linho Sintético c/ Forro', 3, 2.6)`, [o.id]);
    await pool.query(
      `INSERT INTO pedidos (loja_id, numero_pedido, orcamento_id, cliente_id, vendedor_id, valor_total_final,
         forma_pagamento_final, status_operacional, data_instalacao_realizada)
       VALUES ($1, 'PED-0001', $2, $3, $4, 2745.40, 'PIX', 'INSTALADO_CONCLUIDO', '2026-11-20T14:00:00Z')`, [LOJA, o.id, idJoao, idAna]);

    const ficha = (await req(ana, 'GET', `/api/clientes/${idJoao}`)).json();
    expect(ficha.historico.pedidos).toHaveLength(1);
    expect(ficha.historico.pedidos[0]).toMatchObject({ numeroPedido: 'PED-0001', formaPagamento: 'PIX', valorTotal: '2745.40' });
    expect(ficha.historico.pedidos[0].produtos).toMatch(/Sala: Cortina Wave/);
    expect(ficha.historico.instalacoes).toHaveLength(1);
    expect(ficha.historico.orcamentos[0].codigo).toBe('ORC-0001');

    for (const q of ['linho', 'wave', 'sintetico']) {
      const lista = (await req(ana, 'GET', `/api/clientes?q=${q}`)).json().clientes;
      expect(lista.map((c: { id: string }) => c.id), q).toContain(idJoao);
    }
  });

  it('% na busca é texto, não curinga ("Solar 3%")', async () => {
    expect((await req(ana, 'GET', `/api/clientes?q=${encodeURIComponent('%')}`)).json().clientes).toHaveLength(0);
  });

  it('pacote offline traz só os clientes ativos do vendedor', async () => {
    const p = (await req(beto, 'GET', '/api/clientes/pacote-offline')).json();
    expect(p.clientes.map((c: { nomeCompleto: string }) => c.nomeCompleto)).toEqual(['Maria Souza']);
    expect(p.geradoEm).toBeTruthy();
  });

  it('ADMIN inativa; inativo some da lista padrão', async () => {
    const { clientes } = (await req(beto, 'GET', '/api/clientes')).json();
    await req(admin, 'PATCH', `/api/clientes/${clientes[0].id}`, { ativo: false });
    expect((await req(beto, 'GET', '/api/clientes')).json().clientes).toHaveLength(0);
    expect((await req(beto, 'GET', '/api/clientes?inativos=1')).json().clientes).toHaveLength(1);
  });

  it('sem login: 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/clientes' })).statusCode).toBe(401);
  });
});
