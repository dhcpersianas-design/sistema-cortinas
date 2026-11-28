import { Decimal, d, ErroEntrada, naoNegativo, positivo, ZERO, type Numerico } from './decimal.js';
import { componente, f2, fecharResultado, metaNum, obterAuxiliar } from './comum.js';
import {
  acionamentosDoModelo, adicionaisAplicados, textoAdicional, adicionaisDoModelo, limitesDoModelo, somarAdicionais,
  bandosDoModelo, rotuloBando, bandoIncluso, adicionalCompativel,
} from './linha-persiana.js';
import type { Alerta, Catalogo, ComponenteCalculado, Produto, ResultadoCalculo } from './tipos.js';

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
  /** Qual bandô/sanefa da linha (metadata.bandos). Sem ele, usa o primeiro da lista ou skus.bando. */
  skuBando?: string;
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
  /** Opcionais da linha marcados pelo vendedor (códigos de `metadata.adicionais`, ex.: CASCATA). */
  adicionais?: string[];
  /** Modelo de acionamento (D, E, B, C, SPT, DUPLEX, H, EL, DE, DD, ED), quando a linha define. */
  modeloAcionamento?: string;
}

/** Peças da linha cadastradas no produto (`metadata.skus`), ex.: o bandô certo de cada linha. */
function skusDaLinha(p: Produto): Partial<SkusPersiana> {
  const s = p.metadata?.['skus'];
  if (!s || typeof s !== 'object') return {};
  return Object.fromEntries(Object.entries(s as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v)) as Partial<SkusPersiana>;
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
  const skus = { ...SKUS_PERSIANA_PADRAO, ...skusDaLinha(pPer), ...e.skus };
  const motorizado = e.acionamento === 'MOTORIZADO';
  const modelosOk = acionamentosDoModelo(pPer);
  if (e.modeloAcionamento && modelosOk.length > 0 && !modelosOk.includes(e.modeloAcionamento)) {
    throw new ErroEntrada(`Modelo de acionamento ${e.modeloAcionamento} não existe para ${pPer.nome} (use ${modelosOk.join(', ')}).`);
  }
  const adicionais = adicionaisAplicados(pPer, e.adicionais, { larguraPeca: L, motorizado, modelo: e.modeloAcionamento });
  for (const a of adicionais) {
    if (a.automatico?.larg_menor_que !== undefined) {
      alertas.push({ codigo: 'ADICIONAL_AUTOMATICO', severidade: 'ATENCAO',
        mensagem: `Largura ${f2(L)}m menor que ${f2(d(a.automatico.larg_menor_que))}m: a fábrica cobra "${textoAdicional(a)}" (já somado).` });
    }
  }
  const lim = limitesDoModelo(pPer, motorizado, adicionais.map((a) => a.codigo));

  // ---------- Passo A: área ----------
  const area = calcularAreaPersianaM2({
    larguraReal: L,
    alturaReal: H,
    larguraMin: metaNum(pPer, 'larg_min', 0),
    alturaMin: metaNum(pPer, 'alt_min', 0),
    areaMin: metaNum(pPer, 'area_min', 0),
  });
  comps.push(somarAdicionais(
    componente(pPer, area.areaFaturavel.mul(nP), `${med.log}; ${area.log}${txtPecas}`),
    pPer, adicionais, { larguraPeca: L, numPecas },
  ));

  // Regras do modelo (metadata do catálogo): avisam o vendedor; nada disso vai para o PDF do cliente.
  const lMin = metaNum(pPer, 'larg_min', 0);
  const aMin = metaNum(pPer, 'alt_min', 0);
  const areaMin = metaNum(pPer, 'area_min', 0);
  if (lMin.gt(0) && L.lt(lMin)) {
    alertas.push({ codigo: 'LARGURA_ABAIXO_MINIMO', severidade: 'ATENCAO',
      mensagem: `Largura ${f2(L)}m abaixo da mínima de ${f2(lMin)}m deste modelo: cobrada como ${f2(lMin)}m. Confirme com a fábrica se produz.` });
  }
  if (aMin.gt(0) && H.lt(aMin)) {
    alertas.push({ codigo: 'ALTURA_ABAIXO_MINIMO', severidade: 'ATENCAO',
      mensagem: `Altura ${f2(H)}m abaixo da mínima cobrada de ${f2(aMin)}m deste modelo: cobrada como ${f2(aMin)}m.` });
  }
  if (areaMin.gt(0) && L.mul(H).lt(areaMin)) {
    alertas.push({ codigo: 'AREA_ABAIXO_MINIMO', severidade: 'ATENCAO',
      mensagem: `Área de ${f2(L.mul(H))}m² por peça abaixo da mínima de ${f2(areaMin)}m² deste modelo: cobrada pela área mínima (${f2(area.areaFaturavel)}m²).` });
  }
  // Máximos: com "sob consulta" cadastrado, passar do recomendado só avisa; passar do sob consulta é crítico.
  const SEM_GARANTIA = 'Acima do recomendado é sob consulta à fábrica e a característica não é defeito (sem garantia).';
  if (lim.larg_min_producao !== undefined && L.lt(lim.larg_min_producao)) {
    alertas.push({ codigo: 'LARGURA_ABAIXO_PRODUCAO', severidade: 'CRITICO',
      mensagem: `Largura ${f2(L)}m abaixo da mínima que a fábrica produz (${f2(d(lim.larg_min_producao))}m) para este modelo.` });
  }
  const checarMaximo = (medida: Decimal, max: number | undefined, consulta: number | undefined, oQue: 'Largura' | 'Altura', codigo: string, msgCritica: string) => {
    if (max === undefined || !medida.gt(max)) return;
    if (consulta !== undefined && medida.lte(consulta)) {
      alertas.push({ codigo: 'SOB_CONSULTA', severidade: 'ATENCAO',
        mensagem: `${oQue} ${f2(medida)}m acima do recomendado (${f2(d(max))}m), até ${f2(d(consulta))}m. ${SEM_GARANTIA}` });
      return;
    }
    alertas.push({ codigo, severidade: 'CRITICO', mensagem: msgCritica });
  };
  checarMaximo(L, lim.larg_max, lim.larg_max_consulta, 'Largura', 'LARGURA_EXCEDE_ROLO',
    lim.larg_max_consulta !== undefined
      ? `Largura ${f2(L)}m acima do máximo sob consulta (${f2(d(lim.larg_max_consulta))}m) deste modelo. Divida o vão em mais peças.`
      : `Largura ${f2(L)}m excede o limite de ${f2(d(lim.larg_max ?? 0))}m do rolo/tubo deste tecido. Divida o vão em 2 peças ou consulte fábrica sobre rotação/emenda.`);
  checarMaximo(H, lim.alt_max, lim.alt_max_consulta, 'Altura', 'ALTURA_EXCEDE_MAXIMO',
    lim.alt_max_consulta !== undefined
      ? `Altura ${f2(H)}m acima do máximo sob consulta (${f2(d(lim.alt_max_consulta))}m) deste modelo. Não vender sem a fábrica confirmar.`
      : `Altura ${f2(H)}m acima da máxima de ${f2(d(lim.alt_max ?? 0))}m deste modelo. Consulte a fábrica antes de vender.`);
  if (lim.area_max !== undefined && L.mul(H).gt(lim.area_max)) {
    alertas.push({ codigo: 'SOB_CONSULTA', severidade: 'ATENCAO',
      mensagem: `Área de ${f2(L.mul(H))}m² por peça acima da máxima recomendada (${f2(d(lim.area_max))}m²). ${SEM_GARANTIA}` });
  }
  const semGarantia = pPer.metadata?.['sem_garantia_larg_acima'];
  if (semGarantia !== undefined && L.gt(d(semGarantia as number))) {
    alertas.push({ codigo: 'SEM_GARANTIA', severidade: 'ATENCAO',
      mensagem: `Largura ${f2(L)}m acima de ${f2(d(semGarantia as number))}m: a fábrica não dá garantia neste modelo. Avise o cliente.` });
  }
  const escolhidos = new Set(adicionais.map((a) => a.codigo));
  for (const a of adicionaisDoModelo(pPer)) {
    if (a.sugerir_area_acima !== undefined && !escolhidos.has(a.codigo) && adicionalCompativel(a, { motorizado, modelo: e.modeloAcionamento }) && L.mul(H).gt(a.sugerir_area_acima)) {
      alertas.push({ codigo: 'SUGERIR_ADICIONAL', severidade: 'ATENCAO',
        mensagem: `Peça com ${f2(L.mul(H))}m² (acima de ${f2(d(a.sugerir_area_acima))}m²): a fábrica recomenda "${a.rotulo}". Marque o opcional.` });
    }
  }
  const limiteRedutor = (() => {
    try {
      return metaNum(catalogo.obter(skus.redutorPeso), 'sugerir_largura_maior_m', '2.40');
    } catch {
      return new Decimal('2.40');
    }
  })();
  const enrolavel = pPer.metadata?.['enrolavel'] !== false;
  const sugereRedutor = enrolavel && L.gt(limiteRedutor) && e.acionamento === 'MANUAL';
  if (sugereRedutor && !e.incluirRedutorPeso) {
    alertas.push({
      codigo: 'SUGERIR_REDUTOR_PESO',
      severidade: 'ATENCAO',
      mensagem: `Vão largo (${f2(L)}m) em acionamento manual. Sugerido adicionar Redutor de Peso / Mola de Alívio (${skus.redutorPeso}) ou Motorização.`,
      skuSugerido: skus.redutorPeso,
    });
  }
  if (enrolavel && H.gt(L.mul('2.5'))) {
    alertas.push({
      codigo: 'RISCO_TELESCOPAGEM',
      severidade: 'ATENCAO',
      mensagem: `Proporção estreita e alta (${f2(H)}m > 2,5 x ${f2(L)}m): risco de telescopagem no rolo.`,
    });
  }

  // ---------- Passo B ----------
  const nomeBando = rotuloBando(pPer);
  const opcoesBando = bandosDoModelo(pPer);
  if (e.skuBando && opcoesBando.length > 0 && !opcoesBando.includes(e.skuBando)) {
    throw new ErroEntrada(`${nomeBando} ${e.skuBando} não serve para ${pPer.nome} (use ${opcoesBando.join(', ')}).`);
  }
  const obterOuNada = (sku: string) => { try { return catalogo.obter(sku); } catch { return undefined; } };
  const bandoServe = (sku: string) => motorizado || obterOuNada(sku)?.metadata?.['somente_motorizado'] !== true;
  if (e.possuiBando && e.skuBando && !bandoServe(e.skuBando)) {
    throw new ErroEntrada(`${obterOuNada(e.skuBando)?.nome ?? e.skuBando} é só para persiana motorizada.`);
  }
  const skuBando = e.skuBando ?? opcoesBando.find(bandoServe) ?? opcoesBando[0] ?? skus.bando;
  const comBando = !!e.possuiBando && !bandoIncluso(pPer);
  if (e.possuiBando && bandoIncluso(pPer)) {
    alertas.push({ codigo: 'BANDO_INCLUSO', severidade: 'INFO', mensagem: `${pPer.nome} já vem com o bandô: não somei bandô avulso.` });
  }
  if (comBando) {
    const p = obterAuxiliar(catalogo, skuBando, alertas, `${nomeBando === 'Bandô' ? 'O bandô' : `A ${nomeBando.toLowerCase()}`}`);
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
  const motorIncluso = pPer.metadata?.['motor_incluso'] === true;
  if (e.acionamento === 'MOTORIZADO') {
    // Linha com motorização própria (ex.: Magic: trilho motorizado + motor com controle) já soma nos adicionais.
    if (!motorIncluso) {
      aux(skus.motor, 'O motor', nP, `1 PC por persiana motorizada${txtPecas}`);
      const qc = e.qtdControles ?? 1;
      if (qc > 0) aux(skus.controle, 'O controle remoto', new Decimal(qc), `${qc} PC sugerido por ambiente/orçamento (editável)`);
    }
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
    modeloAcionamento: e.modeloAcionamento,
    adicionais: adicionais.map((a) => a.rotulo),
    prazoFabricaDias: pPer.metadata?.['prazo_fabrica_dias'],
    ladoComando: e.ladoComando,
    sentidoEnrolamento: e.sentidoEnrolamento,
    fixacao: e.fixacao,
    tuboMinimoRecomendado: tuboRecomendado(L),
    bando: comBando,
    bandoSku: comBando ? skuBando : undefined,
    rotuloBando: nomeBando,
    guiaLateral: !!e.possuiGuiaLateral,
    calhaInferior: !!e.possuiCalhaInferior,
  });
}
