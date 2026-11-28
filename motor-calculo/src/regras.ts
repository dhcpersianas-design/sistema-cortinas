/**
 * Regras do modelo escolhido, em texto simples, para o QUADRO DE ATENÇÃO do vendedor
 * enquanto monta o item (pedido do Gabriel, 27/11/2026). Vêm da metadata do catálogo:
 * largura/altura mínima e máxima, área mínima cobrada, largura do rolo, barra máxima etc.
 * Só para uso interno: nada disto vai para o PDF do cliente.
 * Quando o item calculado QUEBRA uma regra, o motor gera um alerta no item (persiana.ts, cortina.ts).
 */
import { d } from './decimal.js';
import { SKUS_CORTINA_PADRAO } from './cortina.js';
import { SKUS_PERSIANA_PADRAO } from './persiana.js';
import { acionamentosDoModelo, adicionaisDoModelo, avisosDoModelo, bandoIncluso, bandosDoModelo, MODELOS_ACIONAMENTO, rotuloBando, textoAdicional } from './linha-persiana.js';
import type { Produto } from './tipos.js';

export interface RegraModelo {
  /** Assunto curto (ex.: "Largura máxima"). */
  titulo: string;
  texto: string;
}

export interface ModeloEscolhido {
  tipo: 'CORTINA' | 'PERSIANA';
  persiana?: string;
  tecido?: string;
  forro?: string;
  trilho?: string;
  trilhoMotorizado?: string;
  confeccao?: string;
  acionamento?: string;
}

type Obter = (sku: string) => Pick<Produto, 'sku' | 'nome' | 'metadata'> | undefined;

const num = (p: Pick<Produto, 'metadata'> | undefined, k: string): number | null => {
  const v = p?.metadata?.[k];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const m = (v: number) => `${d(v).toFixed(2).replace('.', ',')} m`;
const m2 = (v: number) => `${d(v).toFixed(2).replace('.', ',')} m²`;

/** Regras do modelo para mostrar ao vendedor. Produtos não encontrados são ignorados. */
export function regrasDoModelo(e: ModeloEscolhido, obter: Obter): RegraModelo[] {
  const r: RegraModelo[] = [];
  const add = (titulo: string, texto: string) => r.push({ titulo, texto });

  if (e.tipo === 'PERSIANA') {
    const p = e.persiana ? obter(e.persiana) : undefined;
    if (!p) return r;
    const lMin = num(p, 'larg_min'); const lMax = num(p, 'larg_max');
    const aMin = num(p, 'alt_min'); const aMax = num(p, 'alt_max');
    const area = num(p, 'area_min');
    const lCons = num(p, 'larg_max_consulta'); const aCons = num(p, 'alt_max_consulta');
    const lProd = num(p, 'larg_min_producao'); const areaMax = num(p, 'area_max');
    const prazo = num(p, 'prazo_fabrica_dias');
    if (prazo) add('Prazo da fábrica', `${prazo} dias úteis.`);
    if (lMax) add('Largura máxima', lCons ? `${m(lMax)} recomendada; até ${m(lCons)} sob consulta, sem garantia.` : `${m(lMax)} por peça. Acima disso, divida o vão em mais peças.`);
    if (lProd) add('Largura mínima produzida', `${m(lProd)}. Abaixo disso, a fábrica não produz.`);
    if (lMin) add('Largura mínima', `${m(lMin)}. Abaixo disso, é cobrada como ${m(lMin)}.`);
    if (aMax) add('Altura máxima', aCons ? `${m(aMax)} recomendada; até ${m(aCons)} sob consulta, sem garantia.` : `${m(aMax)}. Acima disso, consulte a fábrica.`);
    if (areaMax) add('Área máxima', `${m2(areaMax)} por peça recomendada. Acima disso, sob consulta e sem garantia.`);
    if (aMin) add('Altura mínima cobrada', `${m(aMin)}. Abaixo disso, é cobrada como ${m(aMin)}.`);
    if (area) add('Área mínima cobrada', `${m2(area)} por peça. Peça menor é cobrada como ${m2(area)}.`);
    for (const t of avisosDoModelo(p)) add('Atenção', t);
    const ads = adicionaisDoModelo(p);
    if (ads.length) add('Opcionais', ads.map(textoAdicional).join('; ') + '.');
    if (bandoIncluso(p)) add('Bandô', 'Já vem com a peça (não soma bandô avulso).');
    else if (bandosDoModelo(p).length) add(rotuloBando(p), `Opcional, vendido à parte: marque "${rotuloBando(p)}" e escolha o modelo.`);
    const acs = acionamentosDoModelo(p);
    if (acs.length) add('Acionamentos', acs.map((a) => MODELOS_ACIONAMENTO[a] ?? `Modelo ${a}`).join('; ') + '.');
    if (p.metadata?.['motor_incluso'] === true) {
      add('Motorizada', 'A motorização desta linha já entra nos opcionais (não soma motor e controle avulsos).');
      return r;
    }
    // Telescopagem e redutor de peso só fazem sentido em tecido que enrola no tubo (rolo, double vision...).
    if (p.metadata?.['enrolavel'] === false) return r;
    const redutor = obter(SKUS_PERSIANA_PADRAO.redutorPeso);
    const lRed = num(redutor, 'sugerir_largura_maior_m') ?? 2.4;
    if (e.acionamento !== 'MOTORIZADO') add('Manual largo', `Acima de ${m(lRed)} no manual, sugerido redutor de peso (mola de alívio) ou motor.`);
    add('Proporção', 'Altura maior que 2,5 vezes a largura tem risco de o tecido enrolar torto (telescopagem).');
    return r;
  }

  const tecido = e.tecido ? obter(e.tecido) : undefined;
  const lRolo = num(tecido, 'largura_rolo');
  if (tecido && lRolo) add('Largura do rolo do tecido', `${m(lRolo)}. Altura de corte acima disso exige corte em tiras, com emendas verticais.`);
  const forro = e.forro ? obter(e.forro) : undefined;
  const lRoloF = num(forro, 'largura_rolo');
  if (forro && lRoloF) add('Largura do rolo do forro', `${m(lRoloF)}. Acima disso, corte em tiras.`);
  const motor = e.trilhoMotorizado ? obter(e.trilhoMotorizado) : undefined;
  if (motor) {
    const faixas = (motor.metadata?.['faixas_skus'] ?? motor.metadata?.['faixas'] ?? []) as { ate: number }[];
    const max = faixas.length ? Math.max(...faixas.map((f) => Number(f.ate))) : null;
    add('Trilho motorizado', `Sistema completo (trilho pronto com motor): não soma trilho comum, deslizantes, terminais nem garras. Preço pela faixa de largura (o sistema escolhe o trilho "ATÉ" a medida que atende: 4,35 m usa o de até 4,50 m)${max ? `; máximo ${m(max)} (acima a fábrica não produz)` : ''}.`);
    add('Controle remoto', 'Não vem com o trilho: confira o controle sugerido no orçamento (1 canal aciona 1 peça).');
    const modelo = String(motor.metadata?.['modelo'] ?? '');
    if (modelo) add('Modelo do trilho', modelo === 'WAVE' ? 'Wave (botão): só para cortina Wave.' : 'Standard (franzida): para cortina franzida ou prega.');
  }
  const trilho = motor ? undefined : obter(e.trilho || SKUS_CORTINA_PADRAO.trilho);
  if (trilho) {
    const ehVarao = String(trilho.metadata?.['tipo'] ?? '').toUpperCase() === 'VARAO';
    const barra = num(trilho, 'barra_max');
    const minMl = num(trilho, 'min_ml');
    if (barra && !ehVarao) add('Barra máxima do trilho', `${m(barra)}. Trilho maior é dividido em barras; a emenda não é calculada.`);
    if (minMl) add('Trilho mínimo cobrado', `${m(minMl)}.`);
    if (e.forro && num(trilho, 'vias') === 1) add('Forro', 'Com forro, use trilho duplo (2 vias) para o forro correr separado.');
    if (e.confeccao === 'WAVE' && ehVarao) add('Wave em varão', 'Cortina Wave não funciona em varão: escolha um trilho.');
  }
  if (e.confeccao === 'WAVE') add('Cortineiro de gesso', 'Wave pede no mínimo 15 cm de profundidade (18 cm com forro em trilho duplo).');
  const instAcima = obter(SKUS_CORTINA_PADRAO.instalacaoAcima3m);
  const lInst = num(instAcima, 'larg_min_m');
  add('Instalação', `Cortina com mais de ${m(lInst ? Math.floor(lInst) : 3)} de largura usa a instalação acima de 3 m (valor maior).`);
  add('Pé-direito alto', 'Altura acima de 3,00 m soma adicional na confecção e de andaime/escada.');
  return r;
}
