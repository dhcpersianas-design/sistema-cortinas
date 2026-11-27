import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar, SENHA } from './ajuda.js';
import { gerarPdf, montarProposta } from '../src/orcamentos/proposta.js';

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, ana: string, beto: string, gerente: string;
let clienteAna: string, clienteBeto: string;

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

async function req(cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

function documento(clienteId: string, extra: Record<string, unknown> = {}) {
  return {
    clienteId, titulo: 'Apartamento 302',
    itens: [
      { id: randomUUID(), ambiente: 'Sala', tipo: 'CORTINA', entrada: cortina, ajustes: [] },
      { id: randomUUID(), ambiente: 'Quarto', tipo: 'PERSIANA', entrada: persiana, ajustes: [] },
    ],
    ...extra,
  };
}

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  await criarUsuario(pool, { email: 'ana@loja.com', perfil: 'VENDEDOR' });
  await criarUsuario(pool, { email: 'beto@loja.com', perfil: 'VENDEDOR' });
  await criarUsuario(pool, { email: 'gerente@loja.com', perfil: 'VENDEDOR', podeVerCustos: true });
  app = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  ana = await entrar(app, 'ana@loja.com');
  beto = await entrar(app, 'beto@loja.com');
  gerente = await entrar(app, 'gerente@loja.com');
  clienteAna = (await req(ana, 'POST', '/api/clientes', { nomeCompleto: 'João da Conceição', telefoneWhatsapp: '11 98765-4321', cidade: 'São Paulo', uf: 'SP' })).json().cliente.id;
  clienteBeto = (await req(beto, 'POST', '/api/clientes', { nomeCompleto: 'Maria Souza', telefoneWhatsapp: '21 99999-0000' })).json().cliente.id;
  // Gerente com custos: cliente próprio
  await req(gerente, 'POST', '/api/clientes', { nomeCompleto: 'Cliente Gerente', telefoneWhatsapp: '31 98888-1111' });
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('configurador de orçamento', () => {
  let id: string;

  it('cria por ambiente, explode pelo motor e bate os casos da especificação', async () => {
    id = randomUUID();
    const r = await req(admin, 'PUT', `/api/orcamentos/${id}`, documento(clienteAna));
    expect(r.statusCode, r.body).toBe(200);
    const o = r.json().orcamento;
    expect(o.codigo).toMatch(/^ORC-\d{4}-0001$/);
    expect(o.versao).toBe(1);
    expect(o.status).toBe('RASCUNHO');
    expect(o.editavel).toBe(true);
    expect(o.itens).toHaveLength(2);
    expect(o.itens[0].componentes).toHaveLength(11);
    expect(o.itens[0].descricaoComercial).toBe('Cortina Wave em Linho Sintetico Gaze c/ forro Forro Microfibra 80% (3,00 m x 2,60 m)');
    expect(o.itens[0].vendaTotal).toBe('2745.40');
    expect(o.itens[1].vendaTotal).toBe('2316.60');
    expect(o.totais.total).toBe('5062.00');
    expect(o.totais.custoTotal).toBe('2018.55');
    expect(o.totais.margemLiquidaPct).toBe('60.12');
    expect(o.totais.semaforo).toBe('VERDE');
    expect(o.condicoes.validadeAte).toBeTruthy();
    expect(o.condicoes.prazoEntregaDias).toBe(14);
  });

  it('cliente de outro vendedor é recusado e o vendedor só vê os próprios orçamentos', async () => {
    const r = await req(ana, 'PUT', `/api/orcamentos/${randomUUID()}`, documento(clienteBeto));
    expect(r.statusCode).toBe(400);
    const deAna = randomUUID();
    expect((await req(ana, 'PUT', `/api/orcamentos/${deAna}`, documento(clienteAna))).statusCode).toBe(200);
    expect((await req(beto, 'GET', `/api/orcamentos/${deAna}`)).statusCode).toBe(404);
    expect((await req(beto, 'PUT', `/api/orcamentos/${deAna}`, documento(clienteBeto))).statusCode).toBe(404);
    expect((await req(beto, 'GET', '/api/orcamentos')).json().orcamentos).toHaveLength(0);
    expect((await req(ana, 'GET', '/api/orcamentos')).json().orcamentos.map((x: { id: string }) => x.id)).toContain(deAna);
  });

  it('vendedor sem "pode ver custos" não recebe custo, lucro nem margem; só o semáforo', async () => {
    const novo = randomUUID();
    const o = (await req(ana, 'PUT', `/api/orcamentos/${novo}`, documento(clienteAna))).json().orcamento;
    expect(o.podeVerCustos).toBe(false);
    expect(o.totais.semaforo).toBe('VERDE');
    expect(o.totais).not.toHaveProperty('custoTotal');
    expect(o.totais).not.toHaveProperty('margemLiquidaPct');
    expect(o.itens[0]).not.toHaveProperty('custoTotal');
    expect(o.itens[0].componentes[0]).not.toHaveProperty('custoUnitario');
    expect(o.itens[0].componentes[0]).not.toHaveProperty('custoTotal');
    const { podeVerCustos: _p, ...resto } = o;
    expect(JSON.stringify(resto)).not.toMatch(/custo/i);
  });

  it('ajuste manual é aplicado e auditado', async () => {
    const atual = (await req(admin, 'GET', `/api/orcamentos/${id}`)).json().orcamento;
    const itens = atual.itens.map((i: Record<string, unknown>) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, entrada: i.entrada, ajustes: i.ajustes }));
    itens[0].ajustes = [{ tipo: 'QUANTIDADE', sku: 'FIX-002', quantidade: 9, motivo: 'parede irregular' }, { tipo: 'ADICIONAR', sku: 'FIX-003', quantidade: 1 }];
    const r = await req(admin, 'PUT', `/api/orcamentos/${id}`, { clienteId: clienteAna, titulo: 'Apartamento 302', itens, atualizadoEmBase: atual.atualizadoEm });
    expect(r.statusCode, r.body).toBe(200);
    const o = r.json().orcamento;
    expect(o.versao).toBe(1);
    const garra = o.itens[0].componentes.find((c: { sku: string }) => c.sku === 'FIX-002');
    expect(garra).toMatchObject({ quantidade: '9.0000', quantidadeCalculada: '7.0000', quantidadeOverride: '9.0000', origem: 'MOTOR' });
    expect(o.itens[0].componentes.find((c: { sku: string }) => c.sku === 'FIX-003').origem).toBe('MANUAL');
    expect(o.itens[0].vendaTotal).toBe('2776.40');
    const eventos = (await req(admin, 'GET', `/api/orcamentos/${id}/auditoria`)).json().eventos;
    expect(eventos.map((e: { descricao: string }) => e.descricao)).toEqual(expect.arrayContaining([
      'Sala: Quantidade de FIX-002 alterada para 9 (motivo: parede irregular).',
      'Sala: FIX-003 incluído (1).',
    ]));
  });

  it('snapshot: reajuste no catálogo não muda item que não foi alterado', async () => {
    await pool.query(`UPDATE produtos SET preco_venda_unitario = 999 WHERE sku = 'TEC-001'`);
    try {
      const atual = (await req(admin, 'GET', `/api/orcamentos/${id}`)).json().orcamento;
      const itens = atual.itens.map((i: Record<string, unknown>) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, entrada: i.entrada, ajustes: i.ajustes }));
      const r = await req(admin, 'PUT', `/api/orcamentos/${id}`, { clienteId: clienteAna, titulo: 'Novo título', itens, atualizadoEmBase: atual.atualizadoEm });
      expect(r.json().orcamento.itens[0].vendaTotal).toBe('2776.40');
      // Pedindo para atualizar, recalcula com o preço novo
      const r2 = await req(admin, 'PUT', `/api/orcamentos/${id}`, { clienteId: clienteAna, itens, atualizarPrecos: true, atualizadoEmBase: r.json().orcamento.atualizadoEm });
      expect(r2.json().orcamento.itens[0].vendaTotal).not.toBe('2776.40');
      const r3 = await req(admin, 'PUT', `/api/orcamentos/${id}`, { clienteId: clienteAna, itens, atualizarPrecos: true, atualizadoEmBase: r2.json().orcamento.atualizadoEm });
      expect(r3.statusCode).toBe(200);
    } finally {
      await pool.query(`UPDATE produtos SET preco_venda_unitario = 110 WHERE sku = 'TEC-001'`);
    }
    const atual = (await req(admin, 'GET', `/api/orcamentos/${id}`)).json().orcamento;
    const itens = atual.itens.map((i: Record<string, unknown>) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, entrada: i.entrada, ajustes: i.ajustes }));
    const r = await req(admin, 'PUT', `/api/orcamentos/${id}`, { clienteId: clienteAna, itens, atualizarPrecos: true, atualizadoEmBase: atual.atualizadoEm });
    expect(r.json().orcamento.itens[0].vendaTotal).toBe('2776.40');
  });

  it('medida absurda (cm digitado como m) é recusada', async () => {
    const r = await req(ana, 'PUT', `/api/orcamentos/${randomUUID()}`, {
      clienteId: clienteAna, itens: [{ id: randomUUID(), ambiente: 'Sala', tipo: 'CORTINA', entrada: { ...cortina, larguraTrilho: '300' }, ajustes: [] }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().erro).toMatch(/Confira se digitou em metros/);
  });

  it('desconto é rateado entre itens e componentes', async () => {
    const atual = (await req(admin, 'GET', `/api/orcamentos/${id}`)).json().orcamento;
    const itens = atual.itens.map((i: Record<string, unknown>) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, entrada: i.entrada, ajustes: i.ajustes }));
    const o = (await req(admin, 'PUT', `/api/orcamentos/${id}`, {
      clienteId: clienteAna, itens, atualizadoEmBase: atual.atualizadoEm,
      condicoes: { descontoTipo: 'VALOR', descontoValor: '100.00', formaPagamento: 'PIX' },
    })).json().orcamento;
    expect(o.totais.descontoValor).toBe('100.00');
    const somaItens = o.itens.reduce((s: number, i: { descontoRateado: string }) => s + Math.round(Number(i.descontoRateado) * 100), 0);
    expect(somaItens).toBe(10000);
    for (const i of o.itens) {
      const somaComp = i.componentes.reduce((s: number, c: { descontoRateado: string }) => s + Math.round(Number(c.descontoRateado) * 100), 0);
      expect(somaComp).toBe(Math.round(Number(i.descontoRateado) * 100));
    }
  });
});

describe('trava de desconto e margem', () => {
  let id: string;
  let atualizadoEm: string;
  let itens: unknown[];

  beforeAll(async () => {
    id = randomUUID();
    const o = (await req(ana, 'PUT', `/api/orcamentos/${id}`, documento(clienteAna))).json().orcamento;
    atualizadoEm = o.atualizadoEm;
    itens = o.itens.map((i: Record<string, unknown>) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, entrada: i.entrada, ajustes: i.ajustes }));
  });

  it('desconto acima do limite do vendedor (10%) bloqueia o envio e o PDF', async () => {
    const r = await req(ana, 'PUT', `/api/orcamentos/${id}`, { clienteId: clienteAna, itens, atualizadoEmBase: atualizadoEm, condicoes: { descontoTipo: 'PERCENTUAL', descontoValor: '12' } });
    const o = r.json().orcamento;
    atualizadoEm = o.atualizadoEm;
    expect(o.totais.semaforo).toBe('VERDE');
    expect(o.liberacao).toMatchObject({ exige: true, pendente: true });
    expect(o.liberacao.motivos[0]).toMatch(/limite do vendedor/);
    const env = await req(ana, 'POST', `/api/orcamentos/${id}/status`, { status: 'ENVIADO' });
    expect(env.statusCode).toBe(409);
    expect(env.json().exigeLiberacao).toBe(true);
    expect((await req(ana, 'GET', `/api/orcamentos/${id}/proposta.pdf`)).statusCode).toBe(409);
  });

  it('margem vermelha não mostra o % para quem não vê custo', async () => {
    const r = await req(ana, 'PUT', `/api/orcamentos/${id}`, { clienteId: clienteAna, itens, atualizadoEmBase: atualizadoEm, condicoes: { descontoTipo: 'PERCENTUAL', descontoValor: '40' } });
    const o = r.json().orcamento;
    atualizadoEm = o.atualizadoEm;
    expect(o.totais.semaforo).toBe('VERMELHO');
    expect(o.liberacao.motivos).toContain('Margem vermelha.');
  });

  it('senha errada não libera; senha do ADMIN libera e vale até a margem cair mais', async () => {
    expect((await req(ana, 'POST', `/api/orcamentos/${id}/liberar`, { email: 'beto@loja.com', senha: SENHA })).statusCode).toBe(403);
    expect((await req(ana, 'POST', `/api/orcamentos/${id}/liberar`, { email: 'admin@loja.com', senha: 'errada123' })).statusCode).toBe(403);
    const r = await req(ana, 'POST', `/api/orcamentos/${id}/liberar`, { email: 'admin@loja.com', senha: SENHA });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().orcamento.liberacao).toMatchObject({ pendente: false, liberado: true, liberadoPorNome: 'admin' });
    // Mais desconto depois da liberação: volta a exigir
    const r2 = await req(ana, 'PUT', `/api/orcamentos/${id}`, { clienteId: clienteAna, itens, atualizadoEmBase: r.json().orcamento.atualizadoEm, condicoes: { descontoTipo: 'PERCENTUAL', descontoValor: '45' } });
    expect(r2.json().orcamento.liberacao.pendente).toBe(true);
    // Volta ao que foi liberado: vale de novo
    const r3 = await req(ana, 'PUT', `/api/orcamentos/${id}`, { clienteId: clienteAna, itens, atualizadoEmBase: r2.json().orcamento.atualizadoEm, condicoes: { descontoTipo: 'PERCENTUAL', descontoValor: '40' } });
    expect(r3.json().orcamento.liberacao.pendente).toBe(false);
    const ev = (await req(ana, 'GET', `/api/orcamentos/${id}/auditoria`)).json().eventos;
    expect(ev.find((e: { acao: string }) => e.acao === 'LIBERACAO_MARGEM').descricao).toBe('Liberado pelo administrador.');
  });
});

describe('versões, snapshot congelado e sincronização offline', () => {
  let v1: string;
  let base: Record<string, unknown>;

  beforeAll(async () => {
    v1 = randomUUID();
    base = (await req(ana, 'PUT', `/api/orcamentos/${v1}`, documento(clienteAna))).json().orcamento;
  });
  const itensDe = (o: Record<string, unknown>) => (o.itens as Record<string, unknown>[]).map((i) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, entrada: i.entrada, ajustes: i.ajustes }));

  it('reenviar a mesma operação (fila offline) não aplica duas vezes', async () => {
    const op = randomUUID();
    const corpo = { clienteId: clienteAna, itens: itensDe(base), atualizadoEmBase: base.atualizadoEm, idOperacao: op, offline: true, titulo: 'Casa' };
    const a = (await req(ana, 'PUT', `/api/orcamentos/${v1}`, corpo)).json();
    const b = (await req(ana, 'PUT', `/api/orcamentos/${v1}`, corpo)).json();
    expect(a.repetido).toBe(false);
    expect(b.repetido).toBe(true);
    expect(b.orcamento.atualizadoEm).toBe(a.orcamento.atualizadoEm);
    base = a.orcamento;
    const ev = (await req(ana, 'GET', `/api/orcamentos/${v1}/auditoria`)).json().eventos;
    expect(ev.filter((e: { acao: string }) => e.acao === 'SINCRONIZADO')).toHaveLength(1);
  });

  it('conflito (editado em dois lugares) vira nova versão, sem sobrescrever', async () => {
    const aparelho = { clienteId: clienteAna, itens: itensDe(base), atualizadoEmBase: base.atualizadoEm, titulo: 'Editado no celular', offline: true };
    // outro lugar grava antes
    const outro = (await req(ana, 'PUT', `/api/orcamentos/${v1}`, { ...aparelho, titulo: 'Editado no computador', offline: false })).json().orcamento;
    const r = await req(ana, 'PUT', `/api/orcamentos/${v1}`, aparelho);
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j.novaVersao).toBe(true);
    expect(j.motivoNovaVersao).toMatch(/alterado em outro lugar/);
    expect(j.orcamento.versao).toBe(2);
    expect(j.orcamento.codigo).toBe(outro.codigo);
    expect(j.orcamento.titulo).toBe('Editado no celular');
    expect((await req(ana, 'GET', `/api/orcamentos/${v1}`)).json().orcamento.titulo).toBe('Editado no computador');
    base = j.orcamento;
  });

  it('enviar congela; editar depois cria a próxima versão e mantém o histórico', async () => {
    const id = base.id as string;
    const env = await req(ana, 'POST', `/api/orcamentos/${id}/status`, { status: 'ENVIADO' });
    expect(env.statusCode, env.body).toBe(200);
    expect(env.json().orcamento).toMatchObject({ status: 'ENVIADO', editavel: false });
    expect(env.json().orcamento.congeladoEm).toBeTruthy();
    const r = await req(ana, 'PUT', `/api/orcamentos/${id}`, {
      clienteId: clienteAna, itens: itensDe(base), atualizadoEmBase: (env.json().orcamento as { atualizadoEm: string }).atualizadoEm,
      condicoes: { descontoTipo: 'PERCENTUAL', descontoValor: '5', medidasConferidas: true },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().orcamento.versao).toBe(3);
    expect(r.json().motivoNovaVersao).toMatch(/congelada/);
    const enviada = (await req(ana, 'GET', `/api/orcamentos/${id}`)).json();
    expect(enviada.orcamento.status).toBe('ENVIADO');
    expect(enviada.orcamento.condicoes.descontoValor).toBe('0.00');
    expect(enviada.transicoes).toEqual([]);
    const versoes = (await req(ana, 'GET', `/api/orcamentos/${id}/versoes`)).json().versoes;
    expect(versoes.map((v: { versao: number }) => v.versao)).toEqual([3, 2, 1]);
    // A lista mostra só a versão mais nova do projeto
    const lista = (await req(ana, 'GET', '/api/orcamentos')).json().orcamentos.filter((o: { codigo: string }) => o.codigo === base.codigo);
    expect(lista).toHaveLength(1);
    expect(lista[0].versao).toBe(3);
  });

  it('nova versão explícita copia o snapshot (ex.: depois da medição)', async () => {
    const id = randomUUID();
    const o = (await req(ana, 'PUT', `/api/orcamentos/${id}`, documento(clienteAna))).json().orcamento;
    expect((await req(ana, 'POST', `/api/orcamentos/${id}/nova-versao`, {})).statusCode).toBe(409); // rascunho: edita direto
    await req(ana, 'POST', `/api/orcamentos/${id}/status`, { status: 'ENVIADO' });
    await req(ana, 'POST', `/api/orcamentos/${id}/status`, { status: 'AGUARDANDO_MEDICAO' });
    const r = await req(ana, 'POST', `/api/orcamentos/${id}/nova-versao`, {});
    expect(r.statusCode, r.body).toBe(201);
    const v2 = r.json().orcamento;
    expect(v2).toMatchObject({ versao: 2, status: 'RASCUNHO', editavel: true, origemId: id });
    expect(v2.totais.total).toBe(o.totais.total);
    expect(v2.itens).toHaveLength(2);
    expect(v2.itens[0].id).not.toBe(o.itens[0].id);
  });

  it('perdido exige motivo e encerra o orçamento', async () => {
    const id = randomUUID();
    await req(ana, 'PUT', `/api/orcamentos/${id}`, documento(clienteAna));
    expect((await req(ana, 'POST', `/api/orcamentos/${id}/status`, { status: 'PERDIDO' })).statusCode).toBe(400);
    expect((await req(ana, 'POST', `/api/orcamentos/${id}/status`, { status: 'PERDIDO', motivoPerda: 'Preço' })).statusCode).toBe(200);
    expect((await req(ana, 'PUT', `/api/orcamentos/${id}`, documento(clienteAna))).statusCode).toBe(409);
  });

  it('pacote offline traz os abertos e os parâmetros de cálculo', async () => {
    const p = (await req(ana, 'GET', '/api/orcamentos/pacote-offline')).json();
    expect(p.orcamentos.length).toBeGreaterThan(0);
    expect(p.orcamentos.every((o: { status: string }) => o.status !== 'PERDIDO')).toBe(true);
    expect(p.parametros.limites).toEqual({ verdeMinPct: '45.0000', amareloMinPct: '35.0000' });
    expect(p.parametros.descontoMaxPct).toBe('10.00');
  });
});

describe('proposta em PDF', () => {
  let id: string;
  beforeAll(async () => {
    id = randomUUID();
    await req(ana, 'PUT', `/api/orcamentos/${id}`, documento(clienteAna, { condicoes: { formaPagamento: 'CREDITO_PARCELADO', parcelas: 3 } }));
  });

  it('dados da proposta: agrupada por ambiente, sem custo, componentes só se pedir', async () => {
    const p = (await montarProposta(app.db, id, false))!;
    expect(p.ambientes.map((a) => a.nome)).toEqual(['Sala', 'Quarto']);
    expect(p.ambientes[0]!.itens[0]).toMatchObject({ valor: 'R$ 2.745,40', medidas: '3,00 × 2,60 m (L × A)', titulo: 'Cortina Wave', icone: 'CORTINA', pecas: 1 });
    expect(p.ambientes[0]!.itens[0]!.detalhes.map((x) => x.rotulo)).toEqual(expect.arrayContaining(['Tecido', 'Forro', 'Abertura', 'Trilho / varão']));
    expect(p.ambientes[1]!.itens[0]!.detalhes).toContainEqual({ rotulo: 'Acionamento', valor: 'Motorizado' });
    expect(p.loja).toMatchObject({ telefone: '(41) 98837-5657', email: 'dhc@dhcpersianas.com.br', instagram: '@dhcpersianas' });
    expect(p.ambientes[0]!.itens[0]!.componentes).toBeUndefined();
    expect(p.total).toBe('R$ 5.062,00');
    expect(p.condicoesPagamento).toBe('Cartão de crédito parcelado em 3x de R$ 1.797,33');
    expect(p.avisoConferencia).toBe(true);
    expect(p.rascunho).toBe(true);
    expect(p.garantia).toBe('Contra defeitos de fabricação e instalação, no prazo indicado para cada item abaixo.');
    expect(p.ambientes.map((a) => a.itens[0]!.garantia)).toEqual(['12 meses', '2 anos; motor 5 anos']);
    expect(p.prazoEntrega).toMatch(/^14 dias úteis \(sem contar sábado e domingo\)/);
    expect(JSON.stringify(p)).not.toMatch(/custo|1053|2018/i);
    const det = (await montarProposta(app.db, id, true))!;
    expect(det.ambientes[0]!.itens[0]!.componentes).toHaveLength(11);
    expect(det.ambientes[0]!.itens[0]!.componentes![5]).toEqual({ descricao: 'Deslizante Wave c/ Cordao 6.7cm', quantidade: '48 UN' });
    const pdf = await gerarPdf(det, { comprimir: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // Montserrat embutida (funciona no servidor sem internet) e logo da loja.
    const bruto = pdf.toString('latin1');
    expect(bruto).toMatch(/\/BaseFont \/[A-Z]{6}\+Montserrat-Bold/);
    expect(bruto).toMatch(/\/BaseFont \/[A-Z]{6}\+Montserrat-Regular/);
    expect(bruto).toMatch(/\/Subtype \/Image/);
    expect(bruto).not.toMatch(/Helvetica/);
  });

  it('PDF pela API e link público para o WhatsApp só depois de enviar', async () => {
    const r = await req(ana, 'GET', `/api/orcamentos/${id}/proposta.pdf`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await req(beto, 'GET', `/api/orcamentos/${id}/proposta.pdf`)).statusCode).toBe(404);

    expect((await req(ana, 'POST', `/api/orcamentos/${id}/link-publico`, {})).statusCode).toBe(409);
    await req(ana, 'POST', `/api/orcamentos/${id}/status`, { status: 'ENVIADO' });
    const l = await req(ana, 'POST', `/api/orcamentos/${id}/link-publico`, { origem: 'https://loja.exemplo.com' });
    expect(l.statusCode, l.body).toBe(201);
    const { caminho, url, whatsapp } = l.json();
    expect(url).toMatch(/^https:\/\/loja\.exemplo\.com\/api\/propostas\//);
    expect(whatsapp).toMatch(/^https:\/\/wa\.me\/5511987654321\?text=/);
    expect(decodeURIComponent(whatsapp)).toContain('R$ 5.062,00');
    const pub = await app.inject({ method: 'GET', url: caminho });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('application/pdf');
    expect((await app.inject({ method: 'GET', url: '/api/propostas/tokeninvalidoaaaaaaaaaaaaaa' })).statusCode).toBe(404);
    await pool.query('UPDATE orcamento_links_publicos SET expira_em = NOW() - interval \'1 day\'');
    expect((await app.inject({ method: 'GET', url: caminho })).statusCode).toBe(404);
  });
});
