import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  calcularCortina, calcularPersiana, paraJSON,
  type EntradaCortina, type EntradaPersiana, type ResultadoCalculo,
} from '@sistema/motor-calculo';
import { exigir } from '../auth/plugin.js';
import { pode } from '../auth/permissoes.js';
import { carregarCatalogoDoBanco } from '../catalogo/catalogo-banco.js';
import { semaforo } from '../catalogo/parametros.js';

/**
 * Simulação de um item usando o motor de cálculo (pacote motor-calculo) com o
 * catálogo do banco. Não grava nada: o configurador de orçamento (Fase 2) vai
 * usar a mesma função e gravar o snapshot.
 * Sem `custos.ver`, a resposta não traz custo, lucro nem margem; só o semáforo.
 */
export async function rotasCalculo(app: FastifyInstance) {
  async function responder(req: FastifyRequest, calcular: (c: Awaited<ReturnType<typeof carregarCatalogoDoBanco>>['catalogo']) => ResultadoCalculo) {
    const { catalogo, avisos } = await carregarCatalogoDoBanco(app.db);
    const r = paraJSON(calcular(catalogo));
    const cor = await semaforo(app.db, req.usuario!.lojaId, r.margemBrutaPct);
    if (pode(req.usuario!, 'custos.ver')) return { ...r, semaforo: cor, avisosCatalogo: avisos };
    const { custoTotalItem: _c, lucroBrutoItem: _l, margemBrutaPct: _m, componentes, ...resto } = r;
    return {
      ...resto,
      componentes: componentes.map(({ custoUnitario: _u, custoTotal: _t, ...c }) => c),
      semaforo: cor,
    };
  }

  app.post('/api/calculo/cortina', { preHandler: exigir('calculo.usar') }, async (req) =>
    responder(req, (cat) => calcularCortina(req.body as EntradaCortina, cat)));

  app.post('/api/calculo/persiana', { preHandler: exigir('calculo.usar') }, async (req) =>
    responder(req, (cat) => calcularPersiana(req.body as EntradaPersiana, cat)));

}
