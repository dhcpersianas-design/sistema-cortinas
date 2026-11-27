import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { appTeste, bancoLimpo, criarUsuario, entrar } from './ajuda.js';
import { hojeLoja } from '../src/pedidos/dias-uteis.js';
import { ratear, somarDias } from '../src/financeiro/servico.js';
import { d } from '@sistema/motor-calculo';

let pool: pg.Pool;
let app: FastifyInstance;
let admin: string, ana: string, beto: string;
let clienteAna: string, clienteBeto: string;
let tecidos: string, costureira: string, fabrica: string, instalador: string;
const hoje = hojeLoja();

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
const PNG = 'data:image/png;base64,' + Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082'
  + '00'.repeat(60), 'hex').toString('base64');

async function req(cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

type Lanc = { id: string; tipo: string; origem: string; valor: string; taxa: string; liquido: string; vencimento: string; status: string; cartao: boolean; fornecedor: string | null; parcela: number; totalParcelas: number };

async function pedidoAprovado(cookie: string, clienteId: string, forma = 'PIX', parcelas = 1) {
  const id = randomUUID();
  const r = await req(cookie, 'PUT', `/api/orcamentos/${id}`, {
    clienteId, titulo: 'Casa',
    condicoes: { descontoTipo: 'PERCENTUAL', descontoValor: '0', acrescimo: '0', parcelas, medidasConferidas: true, formaPagamento: forma },
    itens: [
      { id: randomUUID(), ambiente: 'Sala', tipo: 'CORTINA', entrada: cortina, ajustes: [] },
      { id: randomUUID(), ambiente: 'Quarto', tipo: 'PERSIANA', entrada: persiana, ajustes: [] },
    ],
  });
  expect(r.statusCode, r.body).toBe(200);
  expect((await req(cookie, 'POST', `/api/orcamentos/${id}/status`, { status: 'ENVIADO' })).statusCode).toBe(200);
  const a = await req(cookie, 'POST', `/api/orcamentos/${id}/aprovar`, {});
  expect(a.statusCode, a.body).toBe(201);
  return a.json().pedido as { id: string; numero: string; valorTotal: string; status: string };
}

async function fin(pedidoId: string) {
  const p = (await req(admin, 'GET', `/api/pedidos/${pedidoId}`)).json().pedido;
  return { p, lanc: p.financeiro.lancamentos as Lanc[], lucro: p.financeiro.lucro };
}

beforeAll(async () => {
  pool = await bancoLimpo();
  await criarUsuario(pool, { email: 'admin@loja.com', perfil: 'ADMIN' });
  const anaId = await criarUsuario(pool, { email: 'ana@loja.com', perfil: 'VENDEDOR' });
  await criarUsuario(pool, { email: 'beto@loja.com', perfil: 'VENDEDOR' });
  await pool.query(`UPDATE usuarios SET comissao_padrao = 5, desconto_max_pct = 10 WHERE id = $1`, [anaId]);
  app = await appTeste();
  admin = await entrar(app, 'admin@loja.com');
  ana = await entrar(app, 'ana@loja.com');
  beto = await entrar(app, 'beto@loja.com');
  clienteAna = (await req(ana, 'POST', '/api/clientes', { nomeCompleto: 'Maria Ribeirão', telefoneWhatsapp: '11 97777-1111', bairro: 'Moema', cidade: 'São Paulo', uf: 'SP', origemLead: 'Instagram' })).json().cliente.id;
  clienteBeto = (await req(beto, 'POST', '/api/clientes', { nomeCompleto: 'Carlos Souza', telefoneWhatsapp: '11 96666-2222', bairro: 'Pinheiros', cidade: 'São Paulo', uf: 'SP' })).json().cliente.id;
  const forn = async (nome: string, categoria: string) =>
    (await req(admin, 'POST', '/api/fornecedores', { nomeFantasia: nome, categoria, whatsapp: '11 91234-5678', prazoEntregaDias: 5 })).json().fornecedor.id as string;
  tecidos = await forn('Tecidos Brasil', 'TECIDO');
  costureira = await forn('Ateliê da Rosa', 'COSTUREIRA');
  fabrica = await forn('Fábrica Rolo', 'PERSIANA');
  instalador = await forn('Zé Instalações', 'INSTALADOR');
  await pool.query(`UPDATE produtos SET fornecedor_padrao_id = $1 WHERE categoria_id IN (1, 2, 3, 4)`, [tecidos]);
  await pool.query(`UPDATE produtos SET fornecedor_padrao_id = $1 WHERE categoria_id = 5`, [costureira]);
  await pool.query(`UPDATE produtos SET fornecedor_padrao_id = $1 WHERE categoria_id IN (6, 7, 8)`, [fabrica]);
  // Taxas da maquininha: crédito 3x com 4,5% (sem antecipação), boleto 2%.
  const cfg = (await req(admin, 'GET', '/api/financeiro/config')).json();
  const t = cfg.taxas as { id: number; forma: string; parcelas: number }[];
  const alterar = t.filter((x) => (x.forma === 'CREDITO_PARCELADO' && x.parcelas === 3) || x.forma === 'BOLETO')
    .map((x) => ({ id: x.id, mdr: x.forma === 'BOLETO' ? '2' : '4,5', antecipacao: '0', diasRepasse: x.forma === 'BOLETO' ? 2 : 30 }));
  expect((await req(admin, 'PUT', '/api/financeiro/taxas', { taxas: alterar })).statusCode).toBe(200);
});
afterAll(async () => { await app.close(); await pool.end(); });

describe('funções de apoio', () => {
  it('ratear divide em centavos sem perder nada', () => {
    const p = ratear(d('100.00'), 3);
    expect(p.map((x) => x.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);
    expect(somarDias('2026-11-27', 30)).toBe('2026-12-27');
  });
});

describe('acesso', () => {
  it('financeiro e relatórios são só do administrador', async () => {
    for (const url of ['/api/financeiro/resumo', '/api/financeiro/lancamentos', '/api/financeiro/config', '/api/relatorios', '/api/relatorios/dre']) {
      expect((await req(ana, 'GET', url)).statusCode, url).toBe(403);
    }
    expect((await req(admin, 'GET', '/api/financeiro/resumo')).statusCode).toBe(200);
  });
});

describe('contas a receber e a pagar do pedido', () => {
  let pedido: { id: string; numero: string; valorTotal: string };

  it('aprovar cria o plano: 50% de sinal hoje + 50% de saldo, e a comissão da vendedora', async () => {
    pedido = await pedidoAprovado(ana, clienteAna);
    expect(pedido.valorTotal).toBe('5062.00');
    const { lanc, p } = await fin(pedido.id);
    const rec = lanc.filter((l) => l.tipo === 'RECEITA');
    expect(rec.map((l) => [l.origem, l.valor, l.status])).toEqual([['SINAL', '2531.00', 'PREVISTO'], ['SALDO', '2531.00', 'PREVISTO']]);
    expect(rec[0]!.vencimento).toBe(hoje);
    const com = lanc.find((l) => l.origem === 'COMISSAO')!;
    expect(com.valor).toBe('253.10'); // 5% de 5.062,00
    expect(p.saldo).toBe('5062.00');
    // Vendedor vê o saldo do cliente, mas não o financeiro
    const pv = (await req(ana, 'GET', `/api/pedidos/${pedido.id}`)).json().pedido;
    expect(pv.saldo).toBe('5062.00');
    expect(pv.financeiro).toBeNull();
  });

  it('sinal registrado baixa a cobrança; compras viram contas a pagar com o custo previsto', async () => {
    const r = await req(admin, 'POST', `/api/pedidos/${pedido.id}/liberar-compras`, { valor: '3.000,00', forma: 'PIX', recebidoEm: hoje });
    expect(r.statusCode, r.body).toBe(200);
    const { lanc, p } = await fin(pedido.id);
    const rec = lanc.filter((l) => l.tipo === 'RECEITA');
    // 3.000 pagos: sinal (2.531) + 469 do saldo -> sobra 2.062 em aberto
    expect(rec.find((l) => l.status === 'LIQUIDADO')!.valor).toBe('3000.00');
    expect(rec.filter((l) => l.status === 'PREVISTO').map((l) => l.valor)).toEqual(['2062.00']);
    expect(p.saldo).toBe('2062.00');
    const pagar = lanc.filter((l) => l.origem === 'ORDEM_COMPRA');
    expect(pagar.length).toBe(p.compras.length);
    for (const o of p.compras) {
      expect(pagar.some((l) => l.valor === o.custoPrevisto)).toBe(true);
    }
    // Sinal maior que o saldo em aberto é recusado
    const p2 = await pedidoAprovado(ana, clienteAna);
    expect((await req(admin, 'POST', `/api/pedidos/${p2.id}/liberar-compras`, { valor: '9999', forma: 'PIX', recebidoEm: hoje })).statusCode).toBe(400);
  });

  it('ordem recebida com custo real atualiza a conta a pagar; instalador entra ao agendar', async () => {
    const { p } = await fin(pedido.id);
    const tec = p.compras.find((o: { fornecedorId: string }) => o.fornecedorId === tecidos);
    for (const o of p.compras) {
      const r = await req(admin, 'POST', `/api/compras/${o.id}`, { acao: 'RECEBER', ...(o.id === tec.id ? { custoReal: '900,00' } : {}), ...(!o.fornecedorId ? { fornecedorId: tecidos } : {}) });
      expect(r.statusCode, r.body).toBe(200);
    }
    const quando = new Date(Date.now() + 5 * 864e5).toISOString();
    expect((await req(admin, 'POST', `/api/pedidos/${pedido.id}/agendar`, { data: quando, instaladorId: instalador })).statusCode).toBe(200);
    const { lanc } = await fin(pedido.id);
    const oc = lanc.find((l) => l.origem === 'ORDEM_COMPRA' && l.fornecedor === 'Tecidos Brasil' && l.valor === '900.00');
    expect(oc).toBeTruthy();
    const inst = lanc.find((l) => l.origem === 'INSTALACAO')!;
    expect(inst.fornecedor).toBe('Zé Instalações');
    expect(Number(inst.valor)).toBeGreaterThan(0);
    // Saldo do cliente passa a vencer no dia da instalação
    const saldo = lanc.find((l) => l.tipo === 'RECEITA' && l.status === 'PREVISTO')!;
    expect(saldo.vencimento).toBe(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(quando)));
  });

  it('receber o saldo no crédito 3x gera 3 repasses com a taxa; desfazer volta a cobrar', async () => {
    const r = await req(admin, 'POST', `/api/pedidos/${pedido.id}/receber`, { valor: '2062.00', forma: 'CREDITO_PARCELADO', parcelas: 3, data: hoje });
    expect(r.statusCode, r.body).toBe(200);
    // Até 3x é sem juros: o cliente passa o valor cheio (2.062) e a loja paga a taxa.
    expect(r.json().cobrado).toBe('2062.00');
    let { lanc, p } = await fin(pedido.id);
    const cartao = lanc.filter((l) => l.cartao);
    expect(cartao.map((l) => l.valor)).toEqual(['687.34', '687.33', '687.33']);
    expect(cartao.reduce((s, l) => s.plus(d(l.taxa)), d(0)).toFixed(2)).toBe('92.79'); // 4,5% de 2.062
    expect(cartao.reduce((s, l) => s.plus(d(l.liquido)), d(0)).toFixed(2)).toBe('1969.21');
    expect(cartao.map((l) => l.vencimento)).toEqual([somarDias(hoje, 30), somarDias(hoje, 60), somarDias(hoje, 90)]);
    expect(p.saldo).toBe('0.00');
    // Valor maior que o saldo: recusado
    expect((await req(admin, 'POST', `/api/pedidos/${pedido.id}/receber`, { valor: '1', forma: 'PIX', data: hoje })).statusCode).toBe(409);
    // Desfazer o recebimento do cartão
    const des = await req(admin, 'POST', `/api/financeiro/lancamentos/${cartao[1]!.id}/desfazer`, {});
    expect(des.statusCode, des.body).toBe(200);
    ({ lanc, p } = await fin(pedido.id));
    expect(lanc.filter((l) => l.cartao)).toEqual([]);
    expect(p.saldo).toBe('2062.00');
    // Recebe de novo em PIX
    expect((await req(admin, 'POST', `/api/pedidos/${pedido.id}/receber`, { valor: '2062', forma: 'PIX', data: hoje })).statusCode).toBe(200);
  });

  it('simulação do cartão: crédito de 4x a 12x embute a taxa (tabela Visa/Master); até 3x e débito não; vendedor não vê a taxa', async () => {
    const q = 'valor=1000&forma=CREDITO_PARCELADO&parcelas=12';
    const a = (await req(admin, 'GET', `/api/financeiro/simular-cartao?${q}`)).json();
    expect(a).toMatchObject({ repasse: true, taxaPct: '12.40', cobrado: '1141.56', parcelas: 12, valorParcela: '95.13' });
    const v = (await req(ana, 'GET', `/api/financeiro/simular-cartao?${q}`)).json();
    expect(v).toEqual({ repasse: true, cobrado: '1141.56', parcelas: 12, valorParcela: '95.13' });
    // Débito: preço cheio, sem taxa embutida (a loja paga 1,37%)
    const deb = (await req(admin, 'GET', '/api/financeiro/simular-cartao?valor=1000&forma=DEBITO')).json();
    expect(deb).toMatchObject({ repasse: false, taxaPct: '1.37', cobrado: '1000.00', liquido: '986.30' });
    const pix = (await req(ana, 'GET', '/api/financeiro/simular-cartao?valor=1000&forma=PIX')).json();
    expect(pix.cobrado).toBe('1000.00');
    // Só a tabela Visa/Master existe
    const cfg = (await req(admin, 'GET', '/api/financeiro/config')).json();
    expect(new Set(cfg.taxas.map((t: { bandeira: string }) => t.bandeira))).toEqual(new Set(['TODAS', 'VISA_MASTER']));
  });

  it('lucro real = venda - custo real - taxas - comissão', async () => {
    const { lucro, lanc } = await fin(pedido.id);
    const custo = lanc.filter((l) => ['ORDEM_COMPRA', 'INSTALACAO'].includes(l.origem)).reduce((s, l) => s.plus(d(l.valor)), d(0));
    expect(lucro.custoEstimado).toBe(false);
    expect(lucro.custoReal).toBe(custo.toFixed(2));
    expect(lucro.comissao).toBe('253.10');
    // O recebimento no cartão foi desfeito e pago no PIX: não sobra taxa embutida na venda.
    expect(lucro.venda).toBe('5062.00');
    expect(lucro.lucro).toBe(d(lucro.venda).minus(custo).minus(d(lucro.taxas)).minus(d('253.10')).toFixed(2));
    expect(Number(lucro.desvio)).toBeGreaterThan(0); // tecido custou mais que o previsto
  });

  it('aceite cria o pós-venda; vendedor só vê os dele', async () => {
    const aceite = {
      id: randomUUID(), nomeRecebedor: 'Maria', assinaturaPng: PNG, assinadoEm: new Date().toISOString(),
      checklist: [{ descricao: 'Tudo certo', ok: true }],
    };
    const r = await req(ana, 'POST', `/api/pedidos/${pedido.id}/aceite`, aceite);
    expect(r.statusCode).toBe(201);
    const lista = (await req(ana, 'GET', '/api/pos-venda')).json().posVenda;
    expect(lista).toHaveLength(1);
    expect(lista[0].dataPrevista).toBe(somarDias(hoje, 7));
    expect((await req(beto, 'GET', '/api/pos-venda')).json().posVenda).toHaveLength(0);
    expect((await req(beto, 'POST', `/api/pos-venda/${lista[0].id}`, { status: 'FEITO' })).statusCode).toBe(404);
    expect((await req(ana, 'POST', `/api/pos-venda/${lista[0].id}`, { status: 'FEITO', nota: 5, comentario: 'Adorou' })).statusCode).toBe(200);
    expect((await req(ana, 'GET', '/api/pos-venda?status=FEITO')).json().posVenda[0].nota).toBe(5);
  });
});

describe('aditivo, cancelamento e cartão na aprovação', () => {
  it('aditivo que reduz o valor depois de pago vira devolução ao cliente', async () => {
    const p = await pedidoAprovado(ana, clienteAna);
    expect((await req(admin, 'POST', `/api/pedidos/${p.id}/liberar-compras`, { valor: '5062', forma: 'PIX', recebidoEm: hoje })).statusCode).toBe(200);
    const a = (await req(ana, 'POST', `/api/pedidos/${p.id}/aditivo`, { motivo: 'Tirou a persiana' })).json();
    const o = (await req(ana, 'GET', `/api/orcamentos/${a.orcamentoId}`)).json().orcamento;
    const itens = o.itens.filter((i: { tipo: string }) => i.tipo === 'CORTINA')
      .map((i: { id: string; ambiente: string; tipo: string; entrada: object; ajustes: object[] }) => ({ id: i.id, ambiente: i.ambiente, tipo: i.tipo, entrada: i.entrada, ajustes: i.ajustes }));
    expect((await req(ana, 'PUT', `/api/orcamentos/${a.orcamentoId}`, { clienteId: clienteAna, condicoes: o.condicoes, itens, titulo: o.titulo })).statusCode).toBe(200);
    const c = await req(admin, 'POST', `/api/pedidos/${p.id}/aditivo/confirmar`, {});
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().resultado.avisos.join(' ')).toContain('devolução');
    const { lanc } = await fin(p.id);
    const dev = lanc.find((l) => l.origem === 'DEVOLUCAO')!;
    expect(d(dev.valor).toFixed(2)).toBe(d('5062').minus(d(c.json().pedido.valorTotal)).toFixed(2));
  });

  it('cancelar o pedido cancela as cobranças em aberto e a comissão', async () => {
    const p = await pedidoAprovado(ana, clienteAna);
    expect((await req(admin, 'POST', `/api/pedidos/${p.id}/cancelar`, { motivo: 'Desistiu' })).statusCode).toBe(200);
    const { rows } = await pool.query(`SELECT origem, status FROM lancamentos_financeiros WHERE pedido_id = $1`, [p.id]);
    expect(rows.every((r) => r.status === 'CANCELADO')).toBe(true);
    expect((await req(admin, 'POST', `/api/pedidos/${p.id}/receber`, { valor: '10', forma: 'PIX', data: hoje })).statusCode).toBe(409);
  });

  it('venda no cartão: cobrança única de 100% com a taxa prevista', async () => {
    const p = await pedidoAprovado(beto, clienteBeto, 'CREDITO_PARCELADO', 3);
    const { lanc } = await fin(p.id);
    const rec = lanc.filter((l) => l.tipo === 'RECEITA');
    expect(rec).toHaveLength(1);
    expect(rec[0]!.valor).toBe(p.valorTotal);
    expect(rec[0]!.taxa).toBe(d(p.valorTotal).mul('0.045').toFixed(2)); // 3x é sem juros: a taxa é da loja
    // Recebe em 3x Visa/Master (4,5% no teste): o cliente passa o valor cheio.
    const r = await req(admin, 'POST', `/api/pedidos/${p.id}/receber`, { valor: p.valorTotal, forma: 'CREDITO_PARCELADO', parcelas: 3, bandeira: 'VISA_MASTER', data: hoje });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().cobrado).toBe(d(p.valorTotal).toFixed(2));
    const { lucro, p: pp } = await fin(p.id);
    expect(pp.saldo).toBe('0.00');
    expect(lucro.venda).toBe(d(p.valorTotal).toFixed(2));
    // De 4x a 12x a taxa vai embutida no valor.
    const q = await req(admin, 'GET', '/api/financeiro/simular-cartao?valor=1000&forma=CREDITO_PARCELADO&parcelas=4');
    expect(q.json()).toMatchObject({ repasse: true });
    const q3 = await req(admin, 'GET', '/api/financeiro/simular-cartao?valor=1000&forma=CREDITO_PARCELADO&parcelas=3');
    expect(q3.json()).toMatchObject({ repasse: false, cobrado: '1000.00' });
  });

  it('pedido antigo (sem cobranças) ganha o plano com o sinal já pago ao abrir o financeiro', async () => {
    const p = await pedidoAprovado(beto, clienteBeto);
    await pool.query(`DELETE FROM lancamentos_financeiros WHERE pedido_id = $1`, [p.id]);
    await pool.query(`UPDATE pedidos SET sinal_valor = 1000, sinal_forma = 'PIX', sinal_recebido_em = $2 WHERE id = $1`, [p.id, hoje]);
    expect((await req(admin, 'GET', '/api/financeiro/resumo')).statusCode).toBe(200);
    const { lanc } = await fin(p.id);
    const rec = lanc.filter((l) => l.tipo === 'RECEITA');
    expect(rec.filter((l) => l.status === 'LIQUIDADO').map((l) => l.valor)).toEqual(['1000.00']);
    expect(rec.filter((l) => l.status === 'PREVISTO').reduce((s, l) => s.plus(d(l.valor)), d(0)).toFixed(2)).toBe(d(p.valorTotal).minus(1000).toFixed(2));
  });
});

describe('lançamentos avulsos, despesas fixas e MEI', () => {
  it('despesa avulsa: lança, paga, desfaz e cancela', async () => {
    const cfg = (await req(admin, 'GET', '/api/financeiro/config')).json();
    const aluguel = cfg.planoContas.find((c: { codigo: string }) => c.codigo === '5.01');
    const receita = cfg.planoContas.find((c: { codigo: string }) => c.codigo === '1.04');
    expect((await req(admin, 'POST', '/api/financeiro/lancamentos', { tipo: 'DESPESA', descricao: 'Aluguel', planoContaId: receita.id, valor: '10', vencimento: hoje })).statusCode).toBe(400);
    const r = await req(admin, 'POST', '/api/financeiro/lancamentos', { tipo: 'DESPESA', descricao: 'Aluguel novembro', planoContaId: aluguel.id, valor: '1.500,00', vencimento: hoje });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    expect((await req(admin, 'PUT', `/api/financeiro/lancamentos/${id}`, { valor: '1600' })).statusCode).toBe(200);
    expect((await req(admin, 'POST', `/api/financeiro/lancamentos/${id}/liquidar`, { data: hoje })).statusCode).toBe(200);
    let l = (await req(admin, 'GET', '/api/financeiro/lancamentos?situacao=PAGO&q=aluguel')).json().lancamentos;
    expect(l[0]).toMatchObject({ valor: '1600.00', status: 'LIQUIDADO', contaFinanceira: 'Banco' });
    expect((await req(admin, 'POST', `/api/financeiro/lancamentos/${id}/desfazer`, {})).statusCode).toBe(200);
    expect((await req(admin, 'POST', `/api/financeiro/lancamentos/${id}/cancelar`, {})).statusCode).toBe(200);
    l = (await req(admin, 'GET', '/api/financeiro/lancamentos?situacao=CANCELADO&q=aluguel')).json().lancamentos;
    expect(l).toHaveLength(1);
    // Cobrança de pedido não se baixa pelo "pago": precisa do Receber (forma de pagamento)
    const cob = (await req(admin, 'GET', '/api/financeiro/lancamentos?tipo=RECEITA&situacao=ABERTO')).json().lancamentos[0];
    expect((await req(admin, 'POST', `/api/financeiro/lancamentos/${cob.id}/liquidar`, { data: hoje })).statusCode).toBe(409);
  });

  it('DAS do MEI ligado é lançado todo mês, sem duplicar', async () => {
    const cfg = (await req(admin, 'GET', '/api/financeiro/config')).json();
    const das = cfg.recorrentes.find((r: { descricao: string }) => r.descricao.startsWith('DAS'));
    // Já vem ligado com R$ 87,05 (Gabriel, 27/11/2026), começando no primeiro dia 20 que ainda não passou.
    expect(das).toMatchObject({ ativo: true, valor: '87.05', dia: 20 });
    const diaHoje = Number(hoje.slice(8, 10));
    expect(das.inicio).toBe(diaHoje > 20 ? `${somarDias(`${hoje.slice(0, 8)}28`, 7).slice(0, 8)}01` : `${hoje.slice(0, 8)}01`);
    const r = await req(admin, 'PUT', `/api/financeiro/recorrentes/${das.id}`, { descricao: das.descricao, planoContaId: das.planoContaId, valor: '81,90', dia: 20, ativo: true });
    expect(r.statusCode, r.body).toBe(200);
    await req(admin, 'GET', '/api/financeiro/resumo');
    await req(admin, 'GET', '/api/financeiro/resumo');
    const { rows } = await pool.query(`SELECT mes_referencia, valor_bruto, data_vencimento FROM lancamentos_financeiros WHERE despesa_recorrente_id = $1 ORDER BY 1`, [das.id]);
    expect(rows).toHaveLength(diaHoje > 20 ? 1 : 2); // até o mês que vem, sem o dia 20 que já passou
    expect(rows.every((x: { data_vencimento: Date }) => x.data_vencimento.toISOString().slice(0, 10) >= hoje)).toBe(true);
    expect(rows[0].valor_bruto).toBe('81.90');
  });

  it('alerta do limite do MEI', async () => {
    let mei = (await req(admin, 'GET', '/api/financeiro/mei')).json().mei;
    expect(mei.limite).toBe('110000.00');
    expect(mei.nivel).toBe('OK');
    expect((await req(admin, 'PUT', '/api/financeiro/parametros', { valores: { LIMITE_FATURAMENTO_ANUAL_MEI: '20000' } })).statusCode).toBe(200);
    mei = (await req(admin, 'GET', '/api/financeiro/mei')).json().mei;
    expect(mei.nivel).toBe('ESTOUROU');
    expect(mei.mensagem).toContain('contador');
    expect((await req(admin, 'PUT', '/api/financeiro/parametros', { valores: { LIMITE_FATURAMENTO_ANUAL_MEI: '1000000', SEMAFORO_AMARELO_MIN_PCT: '50' } })).statusCode).toBe(400);
    expect((await req(admin, 'PUT', '/api/financeiro/parametros', { valores: { LIMITE_FATURAMENTO_ANUAL_MEI: '110000' } })).statusCode).toBe(200);
  });
});

describe('os 8 relatórios', () => {
  const ids = ['dre', 'faturamento', 'rentabilidade', 'fluxo-caixa', 'contas', 'funil', 'curva-abc', 'clientes'];
  const periodo = `de=${hoje.slice(0, 8)}01&ate=${somarDias(hoje, 0)}`;

  it('todos respondem em JSON, PDF e XLSX', async () => {
    const lista = (await req(admin, 'GET', '/api/relatorios')).json().relatorios;
    expect(lista.map((r: { id: string }) => r.id)).toEqual(ids);
    for (const id of ids) {
      const j = await req(admin, 'GET', `/api/relatorios/${id}?${periodo}`);
      expect(j.statusCode, `${id}: ${j.body}`).toBe(200);
      expect(j.json().relatorio.tabelas.length).toBeGreaterThan(0);
      const pdf = await req(admin, 'GET', `/api/relatorios/${id}?${periodo}&formato=pdf`);
      expect(pdf.statusCode).toBe(200);
      expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
      const x = await req(admin, 'GET', `/api/relatorios/${id}?${periodo}&formato=xlsx`);
      expect(x.statusCode).toBe(200);
      expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
      expect(lerPlanilha(x.rawPayload)).toContain('<sheetData>');
    }
    expect((await req(admin, 'GET', '/api/relatorios/nao-existe')).statusCode).toBe(404);
    expect((await req(admin, 'GET', `/api/relatorios/dre?de=2026-12-01&ate=2026-11-01`)).statusCode).toBe(400);
  });

  it('DRE por competência fecha com as vendas; por caixa só o recebido', async () => {
    const comp = (await req(admin, 'GET', `/api/relatorios/dre?${periodo}`)).json().relatorio;
    const { rows: [v] } = await pool.query(`SELECT COALESCE(SUM(valor_total_final), 0)::numeric(12,2)::text AS v FROM pedidos WHERE status_operacional <> 'CANCELADO'`);
    const linhas = comp.tabelas[0].linhas as { conta: string; valor: string }[];
    // Receita bruta - devoluções (aditivo que reduziu um pedido já pago) = vendas do período
    const devolucoes = linhas.find((l) => l.conta.startsWith('2.03'))?.valor ?? '0';
    // ... mais a taxa do cartão que o cliente pagou embutida
    const { rows: [a] } = await pool.query(`SELECT COALESCE(SUM(acrescimo_cliente), 0)::numeric(12,2)::text AS v FROM lancamentos_financeiros WHERE status <> 'CANCELADO'`);
    expect(d(comp.resumo[0].valor).plus(d(devolucoes)).toFixed(2)).toBe(d(v.v).plus(d(a.v)).toFixed(2));
    // cortinas, persianas e instalação separadas
    expect(linhas.some((l) => l.conta.startsWith('1.01'))).toBe(true);
    expect(linhas.some((l) => l.conta.startsWith('1.02'))).toBe(true);
    expect(linhas.some((l) => l.conta.startsWith('1.03'))).toBe(true);
    // DAS: aparece no mês em que vence (hoje ou no próximo, se o dia 20 deste mês já passou)
    const prox = `de=${somarDias(hoje, 0).slice(0, 8)}01&ate=${somarDias(hoje, 45)}`;
    const dre2 = (await req(admin, 'GET', `/api/relatorios/dre?${prox}`)).json().relatorio;
    expect((dre2.tabelas[0].linhas as { conta: string }[]).some((l) => l.conta.startsWith('5.04'))).toBe(true);
    const caixa = (await req(admin, 'GET', `/api/relatorios/dre?${periodo}&regime=caixa`)).json().relatorio;
    const { rows: [rc] } = await pool.query(`SELECT COALESCE(SUM(valor_bruto), 0)::numeric(12,2)::text AS v FROM lancamentos_financeiros l
      JOIN plano_contas pc ON pc.id = l.plano_conta_id WHERE l.tipo = 'RECEITA' AND l.status = 'LIQUIDADO' AND pc.grupo_dre = 'RECEITA'
      AND l.data_liquidacao BETWEEN $1 AND $2`, [`${hoje.slice(0, 8)}01`, hoje]);
    expect(caixa.resumo[0].valor).toBe(rc.v);
  });

  it('rentabilidade, funil, ABC e clientes trazem o que se espera', async () => {
    const rent = (await req(admin, 'GET', `/api/relatorios/rentabilidade?${periodo}`)).json().relatorio;
    expect(rent.tabelas[0].linhas.length).toBeGreaterThan(2);
    const funil = (await req(admin, 'GET', `/api/relatorios/funil?${periodo}`)).json().relatorio;
    const porVend = funil.tabelas[0].linhas as { nome: string; aprovados: number }[];
    expect(porVend.find((l) => l.nome === 'ana')!.aprovados).toBeGreaterThan(0);
    expect(funil.tabelas[1].linhas.some((l: { nome: string }) => l.nome === 'Instagram')).toBe(true);
    const abc = (await req(admin, 'GET', `/api/relatorios/curva-abc?${periodo}`)).json().relatorio;
    expect(abc.tabelas[0].linhas[0].classe).toBe('A');
    const cli = (await req(admin, 'GET', `/api/relatorios/clientes?nome=ribeirao&bairro=moema`)).json().relatorio;
    expect(cli.tabelas[0].linhas.length).toBeGreaterThan(0);
    expect(cli.tabelas[0].linhas.every((l: { cliente: string }) => l.cliente === 'Maria Ribeirão')).toBe(true);
    const cliPersiana = (await req(admin, 'GET', `/api/relatorios/clientes?produto=persiana&telefone=96666`)).json().relatorio;
    expect(cliPersiana.tabelas[0].linhas.every((l: { cliente: string }) => l.cliente === 'Carlos Souza')).toBe(true);
    const contas = (await req(admin, 'GET', `/api/relatorios/contas`)).json().relatorio;
    expect(contas.tabelas.map((t: { titulo: string }) => t.titulo)).toContain('Pedidos já instalados com saldo em aberto');
  });
});

/** Abre o XLSX (ZIP) e devolve o XML da planilha. */
function lerPlanilha(buf: Buffer): string {
  let i = 0;
  while (i < buf.length - 4 && buf.readUInt32LE(i) === 0x04034b50) {
    const tam = buf.readUInt32LE(i + 18);
    const nomeLen = buf.readUInt16LE(i + 26);
    const nome = buf.subarray(i + 30, i + 30 + nomeLen).toString();
    const dados = buf.subarray(i + 30 + nomeLen, i + 30 + nomeLen + tam);
    if (nome === 'xl/worksheets/sheet1.xml') return inflateRawSync(dados).toString();
    i += 30 + nomeLen + tam;
  }
  return '';
}
