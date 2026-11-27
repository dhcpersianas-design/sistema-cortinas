import { Decimal, d, ErroEntrada, naoNegativo, positivo, ZERO, type Numerico } from './decimal.js';
import { componente, f2, fecharResultado, metaNum, obterAuxiliar } from './comum.js';
import type { Alerta, Catalogo, ComponenteCalculado, ResultadoCalculo } from './tipos.js';

export type ModoInstalacao = 'DENTRO_VAO' | 'FORA_VAO' | 'TETO';
export type Acionamento = 'MANUAL' | 'MOTORIZADO';

export interface SkusPersiana {
  bando: string;
  guiaLateral: string;
  redutorPeso: string;
  motor: string;
  controle: string;
  hub: string;
  instalacaoManual: string;
  instalacaoMotorizada: string;
}

export const SKUS_PERSIANA_PADRAO: SkusPersiana = {
  bando: 'ACP-001',
  guiaLateral: 'ACP-002',
  redutorPeso: 'ACP-003',
  motor: 'MOT-001',
  controle: 'MOT-002',
  hub: 'MOT-003',
  instalacaoManual: 'SRV-002',
  instalacaoMotorizada: 'SRV-003',
};

export interface FolgasInstalacao {
  dentroVao: { largura: Numerico; altura: Numerico };
  foraVao: { largura: Numerico; altura: Numerico };
  teto: { largura: Numerico; altura: Numerico };
}

export const FOLGAS_PADRAO: FolgasInstalacao = {
  dentroVao: { largura: '-0.01', altura: '-0.01' },
  foraVao: { largura: '0.20', altura: '0.25' },
  teto: { largura: '0.20', altura: '0' },
};

export type Medida =
  | { tipo: 'PRODUCAO'; largura: Numerico; altura: Numerico }
  | {
      tipo: 'VAO_BRUTO';
      modo: ModoInstalacao;
      /** Pode receber as 3 medidas (topo/meio/base); usa-se a MENOR em DENTRO_VAO. */
      largura: Numerico | Numerico[];
      altura: Numerico | Numerico[];
      folgas?: Partial<FolgasInstalacao>;
    };

export interface EntradaPersiana {
  sku: string;
  medida: Medida;
  acionamento: Acionamento;
  ladoComando: 'DIREITO' | 'ESQUERDO';
  sentidoEnrolamento: 'NORMAL' | 'REVERSO';
  fixacao?: 'TETO' | 'PAREDE';
  possuiBando?: boolean;
  folgaBandoM?: Numerico;
  possuiGuiaLateral?: boolean;
  possuiCalhaInferior?: boolean;
  /** Adiciona o redutor de peso quando sugerido (manual > 2,40 m). Padrão false: só alerta. */
  incluirRedutorPeso?: boolean;
  /** Controles remotos neste item. Padrão: 1 se motorizado. Use 0 quando outro item do ambiente já tem. */
  qtdControles?: number;
  /** Hubs Wi-Fi neste item. Padrão 0. */
  qtdHubs?: number;
  /** Divide o vão em N peças iguais (vão maior que a largura máxima do rolo). Padrão 1. */
  numPecas?: number;
  skus?: Partial<SkusPersiana>;
}

function menor(v: Numerico | Numerico[]): Decimal {
  const arr = Array.isArray(v) ? v : [v];
  if (arr.length === 0) throw new ErroEntrada('Medida vazia');
  return arr.map((x) => positivo('medida', x)).reduce((a, b) => Decimal.min(a, b));
}

/** Converte vão bruto em medida de produção (seção 2.1 [B] / 4.2). */
export function medidaProducao(m: Medida): { largura: Decimal; altura: Decimal; log: string; vaoBruto?: { largura: string; altura: string; modo: ModoInstalacao } } {
  if (m.tipo === 'PRODUCAO') {
    const largura = positivo('largura', m.largura);
    const altura = positivo('altura', m.altura);
    return { largura, altura, log: `Medida de produção informada ${f2(largura)} x ${f2(altura)}` };
  }
  const folgas = { ...FOLGAS_PADRAO, ...m.folgas };
  const f = m.modo === 'DENTRO_VAO' ? folgas.dentroVao : m.modo === 'FORA_VAO' ? folgas.foraVao : folgas.teto;
  // Em DENTRO_VAO usa-se a menor das medidas; nos demais também (cobre o pior caso). [SUPOSIÇÃO S5]
  const lb = menor(m.largura);
  const hb = menor(m.altura);
  const largura = lb.plus(d(f.largura));
  const altura = hb.plus(d(f.altura));
  if (largura.lte(0) || altura.lte(0)) throw new ErroEntrada('Medida de produção resultou ≤ 0');
  return {
    largura,
    altura,
    log: `${m.modo}: vão ${f2(lb)} x ${f2(hb)} -> produção ${f2(largura)} x ${f2(altura)}`,
    vaoBruto: { largura: f2(lb), altura: f2(hb), modo: m.modo },
  };
}

/** Passo A da seção 4.2: área faturável com mínimos de fábrica. */
export function calcularAreaPersianaM2(p: {
  larguraReal: Decimal;
  alturaReal: Decimal;
  larguraMin: Decimal;
  alturaMin: Decimal;
  areaMin: Decimal;
}) {
  const lFat = Decimal.max(p.larguraReal, p.larguraMin);
  const hFat = Decimal.max(p.alturaReal, p.alturaMin);
  const areaCalc = lFat.mul(hFat);
  const areaFat = Decimal.max(areaCalc, p.areaMin).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  return {
    areaFaturavel: areaFat,
    log: `L_fat(${f2(lFat)}) * H_fat(${f2(hFat)}) = ${areaCalc.toFixed(4)} -> mín ${f2(p.areaMin)} => ${f2(areaFat)} M2`,
  };
}

/** Tubo mínimo recomendado pela largura (seção 2.3). Informativo. */
export function tuboRecomendado(largura: Decimal): string {
  if (largura.lte('1.50')) return '32mm';
  if (largura.lte('2.40')) return '38mm';
  if (largura.lte('3.40')) return '45mm';
  return '55mm+';
}

export function calcularPersiana(e: EntradaPersiana, catalogo: Catalogo): ResultadoCalculo {
  const skus = { ...SKUS_PERSIANA_PADRAO, ...e.skus };
  const numPecas = e.numPecas ?? 1;
  if (!Number.isInteger(numPecas) || numPecas < 1) throw new ErroEntrada('numPecas deve ser inteiro ≥ 1');
  if (e.acionamento !== 'MANUAL' && e.acionamento !== 'MOTORIZADO') throw new ErroEntrada('acionamento inválido');

  const med = medidaProducao(e.medida);
  const larguraTotal = med.largura;
  // Cada peça é faturada isoladamente (mínimos de fábrica valem por peça). [SUPOSIÇÃO S6]
  const L = larguraTotal.div(numPecas).toDecimalPlaces(3, Decimal.ROUND_DOWN);
  const H = med.altura;
  const nP = new Decimal(numPecas);
  const txtPecas = numPecas > 1 ? ` x ${numPecas} peças` : '';

  const alertas: Alerta[] = [];
  const comps: ComponenteCalculado[] = [];
  const pPer = catalogo.obter(e.sku);

  // ---------- Passo A: área ----------
  const area = calcularAreaPersianaM2({
    larguraReal: L,
    alturaReal: H,
    larguraMin: metaNum(pPer, 'larg_min', 0),
    alturaMin: metaNum(pPer, 'alt_min', 0),
    areaMin: metaNum(pPer, 'area_min', 0),
  });
  comps.push(componente(pPer, area.areaFaturavel.mul(nP), `${med.log}; ${area.log}${txtPecas}`));

  const lMax = pPer.metadata?.['larg_max'] !== undefined ? metaNum(pPer, 'larg_max') : undefined;
  if (lMax && L.gt(lMax)) {
    alertas.push({
      codigo: 'LARGURA_EXCEDE_ROLO',
      severidade: 'CRITICO',
      mensagem: `Largura ${f2(L)}m excede o limite de ${f2(lMax)}m do rolo/tubo deste tecido. Divida o vão em 2 peças ou consulte fábrica sobre rotação/emenda.`,
    });
  }
  const limiteRedutor = (() => {
    try {
      return metaNum(catalogo.obter(skus.redutorPeso), 'sugerir_largura_maior_m', '2.40');
    } catch {
      return new Decimal('2.40');
    }
  })();
  const sugereRedutor = L.gt(limiteRedutor) && e.acionamento === 'MANUAL';
  if (sugereRedutor && !e.incluirRedutorPeso) {
    alertas.push({
      codigo: 'SUGERIR_REDUTOR_PESO',
      severidade: 'ATENCAO',
      mensagem: `Vão largo (${f2(L)}m) em acionamento manual. Sugerido adicionar Redutor de Peso / Mola de Alívio (${skus.redutorPeso}) ou Motorização.`,
      skuSugerido: skus.redutorPeso,
    });
  }
  if (H.gt(L.mul('2.5'))) {
    alertas.push({
      codigo: 'RISCO_TELESCOPAGEM',
      severidade: 'ATENCAO',
      mensagem: `Proporção estreita e alta (${f2(H)}m > 2,5 x ${f2(L)}m): risco de telescopagem no rolo.`,
    });
  }

  // ---------- Passo B ----------
  if (e.possuiBando) {
    const p = obterAuxiliar(catalogo, skus.bando, alertas, 'O bandô');
    const folga = naoNegativo('folgaBandoM', e.folgaBandoM ?? 0);
    if (p) {
      const min = metaNum(p, 'min_ml', '1.00');
      const q = Decimal.max(L.plus(folga), min).toDecimalPlaces(2, Decimal.ROUND_UP);
      comps.push(componente(p, q.mul(nP), `MAX(${f2(L)} + ${f2(folga)}, ${f2(min)}) = ${f2(q)} ML${txtPecas}`));
    }
  }
  if (e.possuiGuiaLateral) {
    const p = obterAuxiliar(catalogo, skus.guiaLateral, alertas, 'A guia lateral');
    const q = H.mul(2).plus(e.possuiCalhaInferior ? L : ZERO).toDecimalPlaces(2, Decimal.ROUND_UP);
    if (p) comps.push(componente(p, q.mul(nP), `2 * ${f2(H)}${e.possuiCalhaInferior ? ` + ${f2(L)} (calha)` : ''} = ${f2(q)} ML${txtPecas}`));
  }
  const aux = (sku: string, oQue: string, qtd: Decimal, log: string) => {
    const p = obterAuxiliar(catalogo, sku, alertas, oQue);
    if (p) comps.push(componente(p, qtd, log));
  };
  if (sugereRedutor && e.incluirRedutorPeso) {
    aux(skus.redutorPeso, 'O redutor de peso', nP, `1 PC por peça (manual > ${f2(limiteRedutor)}m)`);
  }
  if (e.acionamento === 'MOTORIZADO') {
    aux(skus.motor, 'O motor', nP, `1 PC por persiana motorizada${txtPecas}`);
    const qc = e.qtdControles ?? 1;
    if (qc > 0) aux(skus.controle, 'O controle remoto', new Decimal(qc), `${qc} PC sugerido por ambiente/orçamento (editável)`);
    const qh = e.qtdHubs ?? 0;
    if (qh > 0) aux(skus.hub, 'O hub Wi-Fi', new Decimal(qh), `${qh} PC no nível do orçamento`);
    aux(skus.instalacaoMotorizada, 'A instalação de persiana motorizada', nP, `1 PC por persiana motorizada${txtPecas}`);
  } else {
    aux(skus.instalacaoManual, 'A instalação de persiana manual', nP, `1 PC por persiana manual${txtPecas}`);
  }

  return fecharResultado('PERSIANA', comps, alertas, {
    sku: pPer.sku,
    vaoBruto: med.vaoBruto,
    larguraProducao: f2(L),
    alturaProducao: f2(H),
    numPecas,
    areaFaturavelPorPeca: area.areaFaturavel.toFixed(4),
    acionamento: e.acionamento,
    ladoComando: e.ladoComando,
    sentidoEnrolamento: e.sentidoEnrolamento,
    fixacao: e.fixacao,
    tuboMinimoRecomendado: tuboRecomendado(L),
    bando: !!e.possuiBando,
    guiaLateral: !!e.possuiGuiaLateral,
    calhaInferior: !!e.possuiCalhaInferior,
  });
}
