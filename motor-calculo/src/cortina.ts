import { Decimal, ceilStep, d, ErroEntrada, naoNegativo, positivo, ZERO, type Numerico } from './decimal.js';
import { componente, f2, fecharResultado, metaBool, metaNum, metaStr } from './comum.js';
import type { Alerta, Catalogo, ComponenteCalculado, Produto, ResultadoCalculo } from './tipos.js';

export type ModoCorte = 'HORIZONTAL' | 'VERTICAL_TIRAS';
export type TipoConfeccao = 'WAVE' | 'PREGA';

export interface CamadaTecido {
  sku: string;
  /** Fator de franzimento (ex.: 2.5). */
  fator: Numerico;
  /** Margem vertical cabeçote + barra. Padrão: 0.30 (principal) / 0.20 (forro). */
  margemBarra?: Numerico;
}

export interface CamadaForro extends CamadaTecido {
  /** Desconto vertical do forro em relação ao tecido. Padrão 0.05. */
  desconto?: Numerico;
}

export interface SkusCortina {
  trilho: string;
  maoObraTecido: string;
  maoObraForro: string;
  deslizanteWave: string;
  deslizanteComum: string;
  fitaWave: string;
  terminal: string;
  /** Garra (trilho) ou suporte (varão). */
  fixacao: string;
  instalacao: string;
  /** Instalação de cortina com trilho acima de 3,00 m (sem tamanho máximo). */
  instalacaoAcima3m: string;
  /** Adicional de andaime/escada especial quando H_pronta > 3,00 m. */
  adicionalPeDireitoAlto: string;
}

export const SKUS_CORTINA_PADRAO: SkusCortina = {
  trilho: 'TRI-002',
  maoObraTecido: 'MDO-001',
  maoObraForro: 'MDO-002',
  deslizanteWave: 'DES-001',
  deslizanteComum: 'DES-002',
  fitaWave: 'DES-003',
  terminal: 'FIX-001',
  fixacao: 'FIX-002',
  instalacao: 'SRV-001',
  instalacaoAcima3m: 'SRV-004',
  adicionalPeDireitoAlto: 'SRV-006',
};

export interface EntradaCortina {
  /** Largura final do trilho/varão instalado (m). */
  larguraTrilho: Numerico;
  /** Altura pronta (m), já descontado o 1-2 cm do piso. */
  alturaPronta: Numerico;
  numFolhas: 1 | 2;
  confeccao: TipoConfeccao;
  tecido: CamadaTecido;
  forro?: CamadaForro;
  skus?: Partial<SkusCortina>;
  /** Folga lateral por folha (bainha). Padrão 0. */
  folgaBainhaLateral?: Numerico;
  /** Múltiplo comercial de corte de tecido (m). Padrão 0.10. */
  arredondamentoML?: Numerico;
  /** Base da mão de obra. Padrão: metadata `base` do SKU de MDO (ML_TECIDO). */
  baseMaoObra?: 'ML_TECIDO' | 'ML_TRILHO';
  /** Força nº par de tiras quando 2 folhas (simetria). Padrão false. */
  exigirSimetriaTiras?: boolean;
  /** Profundidade medida do cortineiro de gesso (m), para alerta. */
  profundidadeCortineiroM?: Numerico;
  /** Acima desta altura aplica adicional de pé-direito alto. Padrão 3.00. */
  limitePeDireitoAltoM?: Numerico;
}

export interface ResultadoTecido {
  quantidade: Decimal;
  modoCorte: ModoCorte;
  alturaCorte: Decimal;
  numTiras?: Decimal;
  log: string;
}

/** Passo A da seção 4.1: consumo de tecido (ML) de uma camada. */
export function calcularTecidoML(p: {
  larguraTrilho: Decimal;
  alturaPronta: Decimal;
  fator: Decimal;
  numFolhas: number;
  larguraRolo: Decimal;
  permiteCorteHorizontal: boolean;
  margemBarra: Decimal;
  descontoAltura?: Decimal;
  folgaBainhaLateral?: Decimal;
  arredondamentoML?: Decimal;
  exigirSimetriaTiras?: boolean;
}): ResultadoTecido {
  const desconto = p.descontoAltura ?? ZERO;
  const folgaLat = p.folgaBainhaLateral ?? ZERO;
  const passo = p.arredondamentoML ?? new Decimal('0.10');

  const alturaCorte = p.alturaPronta.minus(desconto).plus(p.margemBarra);
  const larguraEsticada = p.larguraTrilho.mul(p.fator).plus(folgaLat.mul(p.numFolhas));

  if (p.permiteCorteHorizontal && alturaCorte.lte(p.larguraRolo)) {
    const qtd = ceilStep(larguraEsticada, passo);
    return {
      quantidade: qtd,
      modoCorte: 'HORIZONTAL',
      alturaCorte,
      log: `Corte Horiz. (H_corte ${f2(alturaCorte)}m <= Rolo ${f2(p.larguraRolo)}m): ${f2(p.larguraTrilho)}m * fator ${p.fator.toString()} = ${f2(qtd)} ML`,
    };
  }

  let numTiras = larguraEsticada.div(p.larguraRolo).ceil();
  if (p.exigirSimetriaTiras && p.numFolhas === 2 && !numTiras.mod(2).isZero()) numTiras = numTiras.plus(1);
  const bruto = numTiras.mul(alturaCorte);
  const qtd = ceilStep(bruto, passo);
  return {
    quantidade: qtd,
    modoCorte: 'VERTICAL_TIRAS',
    alturaCorte,
    numTiras,
    log: `Corte Tiras (${numTiras.toString()} tiras * H_corte ${f2(alturaCorte)}m) = ${f2(qtd)} ML`,
  };
}

/** Deslizantes Wave: número PAR por folha. */
export function calcularDeslizantesWave(larguraTrilho: Decimal, numFolhas: number, unPorMetro: Decimal) {
  const porFolha = larguraTrilho.div(numFolhas).mul(unPorMetro).div(2).ceil().mul(2);
  const total = porFolha.mul(numFolhas);
  return {
    quantidade: total,
    log: `${numFolhas} folha(s) * ${porFolha.toString()} un/folha (par obrigatório Wave @ ${unPorMetro.toString()} un/m) = ${total.toString()} UN`,
  };
}

export function calcularGarrasTrilho(larguraTrilho: Decimal, espacamentoM: Decimal, minimo: Decimal) {
  const calc = larguraTrilho.div(espacamentoM).ceil().plus(1);
  const total = Decimal.max(minimo, calc);
  return {
    quantidade: total,
    log: `MAX(${minimo.toString()}, CEIL(${f2(larguraTrilho)} / ${espacamentoM.toString()}) + 1) = ${total.toString()} UN`,
  };
}

/** Suportes de varão: até 2,00 m = 2; acima = 2 + CEIL(L - 2,00). */
export function calcularSuportesVarao(larguraTrilho: Decimal) {
  const dois = new Decimal(2);
  const total = larguraTrilho.lte(dois) ? dois : dois.plus(larguraTrilho.minus(dois).ceil());
  return { quantidade: total, log: `Suportes varão: ${f2(larguraTrilho)}m -> ${total.toString()} UN` };
}

function validar(e: EntradaCortina) {
  if (e.numFolhas !== 1 && e.numFolhas !== 2) throw new ErroEntrada('numFolhas deve ser 1 ou 2');
  if (e.confeccao !== 'WAVE' && e.confeccao !== 'PREGA') throw new ErroEntrada('confeccao deve ser WAVE ou PREGA');
}

export function calcularCortina(e: EntradaCortina, catalogo: Catalogo): ResultadoCalculo {
  validar(e);
  const skus = { ...SKUS_CORTINA_PADRAO, ...e.skus };
  const L = positivo('larguraTrilho', e.larguraTrilho);
  const H = positivo('alturaPronta', e.alturaPronta);
  const folgaLat = naoNegativo('folgaBainhaLateral', e.folgaBainhaLateral ?? 0);
  const passo = positivo('arredondamentoML', e.arredondamentoML ?? '0.10');
  const limitePD = positivo('limitePeDireitoAltoM', e.limitePeDireitoAltoM ?? '3.00');
  const N = e.numFolhas;

  const alertas: Alerta[] = [];
  const comps: ComponenteCalculado[] = [];

  const trilho = catalogo.obter(skus.trilho);
  const ehVarao = metaStr(trilho, 'tipo') === 'VARAO';
  const vias = metaNum(trilho, 'vias', 1);
  const peDireitoAlto = H.gt(limitePD);

  // ---------- Passo A: tecido principal ----------
  const pTecido = catalogo.obter(e.tecido.sku);
  const fTecido = positivo('tecido.fator', e.tecido.fator);
  const tec = calcularTecidoML({
    larguraTrilho: L,
    alturaPronta: H,
    fator: fTecido,
    numFolhas: N,
    larguraRolo: metaNum(pTecido, 'largura_rolo'),
    permiteCorteHorizontal: metaBool(pTecido, 'permite_corte_horizontal', false),
    margemBarra: naoNegativo('tecido.margemBarra', e.tecido.margemBarra ?? '0.30'),
    folgaBainhaLateral: folgaLat,
    arredondamentoML: passo,
    exigirSimetriaTiras: e.exigirSimetriaTiras,
  });
  comps.push(componente(pTecido, tec.quantidade, tec.log));
  alertaCorte(alertas, 'tecido principal', tec, pTecido);

  // ---------- Passo A: forro ----------
  let forro: ResultadoTecido | undefined;
  if (e.forro) {
    const pForro = catalogo.obter(e.forro.sku);
    forro = calcularTecidoML({
      larguraTrilho: L,
      alturaPronta: H,
      fator: positivo('forro.fator', e.forro.fator),
      numFolhas: N,
      larguraRolo: metaNum(pForro, 'largura_rolo'),
      permiteCorteHorizontal: metaBool(pForro, 'permite_corte_horizontal', false),
      margemBarra: naoNegativo('forro.margemBarra', e.forro.margemBarra ?? '0.20'),
      descontoAltura: naoNegativo('forro.desconto', e.forro.desconto ?? '0.05'),
      folgaBainhaLateral: folgaLat,
      arredondamentoML: passo,
      exigirSimetriaTiras: e.exigirSimetriaTiras,
    });
    comps.push(componente(pForro, forro.quantidade, forro.log));
    alertaCorte(alertas, 'forro', forro, pForro);
    if (vias.lt(2)) {
      alertas.push({
        codigo: 'FORRO_SEM_VIA',
        severidade: 'ATENCAO',
        mensagem: 'Cortina com forro em trilho/varão de 1 via. Use trilho duplo para o forro correr separado.',
      });
    }
  }

  // ---------- Passo B1: mão de obra ----------
  const minTrilho = metaNum(trilho, 'min_ml', '1.00');
  const lTrilhoReal = Decimal.max(L, minTrilho).toDecimalPlaces(2, Decimal.ROUND_UP);
  const mdo = (sku: string, qTecido: Decimal, rotulo: string) => {
    const p = catalogo.obter(sku);
    const base = e.baseMaoObra ?? (metaStr(p, 'base') === 'ML_TRILHO' ? 'ML_TRILHO' : 'ML_TECIDO');
    const qtd = base === 'ML_TRILHO' ? lTrilhoReal : qTecido;
    const mult = peDireitoAlto ? metaNum(p, 'fator_pe_direito_alto', '1.30') : new Decimal(1);
    const txtMult = peDireitoAlto ? ` x adicional pé-direito alto ${mult.toString()}` : '';
    comps.push(componente(p, qtd, `MDO ${rotulo} base ${base} = ${f2(qtd)} ML${txtMult}`, mult));
  };
  mdo(skus.maoObraTecido, tec.quantidade, 'tecido');
  if (forro) mdo(skus.maoObraForro, forro.quantidade, 'forro');
  if (peDireitoAlto) {
    alertas.push({
      codigo: 'PE_DIREITO_ALTO',
      severidade: 'ATENCAO',
      mensagem: `Altura pronta ${f2(H)}m acima de ${f2(limitePD)}m: adicional na mão de obra e adicional de andaime/escada especial incluídos.`,
    });
  }

  // ---------- Passo B2: trilho/varão ----------
  // Vendido em barras de metro inteiro (1 a 6 m). Até 6 m: 1 barra arredondada para cima
  // (1,50 -> 2 m; 2,20 -> 3 m). Acima: barras de 6 m quantas couberem + 1 barra com o resto
  // arredondado (6,10 -> 6 m + 1 m). Sem emenda automática: divisão é decisão do instalador.
  const passoBarra = metaNum(trilho, 'passo_venda_m', '1.00');
  const barraMax = metaNum(trilho, 'barra_max', '6.00');
  const barras = decomporBarras(lTrilhoReal, barraMax, passoBarra);
  const qTrilho = barras.reduce((s, b) => s.plus(b.tamanho.mul(b.quantidade)), ZERO);
  const txtBarras = descreverBarras(barras);
  comps.push(...componentesTrilho(trilho, barras, `Barras: MAX(L_trilho ${f2(L)}, mín ${f2(minTrilho)}) -> ${txtBarras}`));
  const totalBarras = barras.reduce((s, b) => s + b.quantidade.toNumber(), 0);
  if (totalBarras > 1) {
    alertas.push({
      codigo: 'TRILHO_ACIMA_BARRA_MAX',
      severidade: 'ATENCAO',
      mensagem: `Trilho de ${f2(L)}m excede a barra máxima de ${f2(barraMax)}m: ${txtBarras} (${f2(qTrilho)} m). Emenda não incluída; confirme a divisão com o instalador.`,
    });
  }

  // ---------- Passo B3/B4: deslizantes ----------
  if (e.confeccao === 'WAVE') {
    if (ehVarao) {
      alertas.push({
        codigo: 'WAVE_EM_VARAO',
        severidade: 'CRITICO',
        mensagem: 'Cortina Wave exige trilho com deslizantes e cordão espaçador; não é compatível com varão.',
      });
    }
    const pW = catalogo.obter(skus.deslizanteWave);
    const w = calcularDeslizantesWave(L, N, metaNum(pW, 'un_por_metro'));
    comps.push(componente(pW, w.quantidade, w.log));
  }
  const pComum = catalogo.obter(skus.deslizanteComum);
  const upmComum = metaNum(pComum, 'un_por_metro', 10);
  const camadasComum = (e.confeccao === 'PREGA' ? 1 : 0) + (forro ? 1 : 0);
  if (camadasComum > 0 && !ehVarao) {
    const porCamada = L.mul(upmComum).ceil();
    const total = porCamada.mul(camadasComum);
    comps.push(componente(pComum, total, `CEIL(${f2(L)} * ${upmComum.toString()} un/m) * ${camadasComum} camada(s) = ${total.toString()} UN`));
  }

  // ---------- Passo B5: fita entretela wave ----------
  if (e.confeccao === 'WAVE') {
    const pFita = catalogo.obter(skus.fitaWave);
    const qFita = tec.modoCorte === 'HORIZONTAL' ? tec.quantidade : ceilStep(L.mul(fTecido), passo);
    const log = tec.modoCorte === 'HORIZONTAL'
      ? `= ML tecido principal (corte horizontal) = ${f2(qFita)} ML`
      : `CEIL((${f2(L)} * ${fTecido.toString()}) / ${passo.toString()}) * ${passo.toString()} = ${f2(qFita)} ML`;
    comps.push(componente(pFita, qFita, log));
  }

  // ---------- Passo B6/B7: terminais e fixação ----------
  if (!ehVarao) {
    const pTerm = catalogo.obter(skus.terminal);
    const porVia = metaNum(pTerm, 'qtd_por_via', 2);
    const qTerm = porVia.mul(vias);
    comps.push(componente(pTerm, qTerm, `${porVia.toString()} * ${vias.toString()} via(s) = ${qTerm.toString()} UN`));
  }
  const pFix = catalogo.obter(skus.fixacao);
  const fix = ehVarao
    ? calcularSuportesVarao(L)
    : calcularGarrasTrilho(L, metaNum(pFix, 'espacamento_m', '0.50'), metaNum(pFix, 'min_un', 2));
  comps.push(componente(pFix, fix.quantidade, fix.log));

  // ---------- Passo B8: instalação (faixas v1.1) ----------
  // Até 3,00 m: SRV-001. Acima: SRV-004 (sem tamanho máximo; 2x o valor de SRV-001).
  const acima3 = L.gt(3);
  const pInst = catalogo.obter(acima3 ? skus.instalacaoAcima3m : skus.instalacao);
  comps.push(componente(pInst, new Decimal(1), `1 UN por cortina (trilho ${f2(L)}m ${acima3 ? '> 3,00m' : '<= 3,00m'})`));
  if (peDireitoAlto) {
    comps.push(componente(catalogo.obter(skus.adicionalPeDireitoAlto), new Decimal(1), `Adicional andaime/escada: H_pronta ${f2(H)}m > ${f2(limitePD)}m`));
  }

  // ---------- Alerta de cortineiro ----------
  if (e.profundidadeCortineiroM !== undefined && e.confeccao === 'WAVE') {
    const prof = positivo('profundidadeCortineiroM', e.profundidadeCortineiroM);
    const comForroDuplo = !!forro && vias.gte(2);
    const minimo = new Decimal(comForroDuplo ? '0.18' : '0.15');
    if (prof.lt(minimo)) {
      alertas.push({
        codigo: 'CORTINEIRO_RASO',
        severidade: 'CRITICO',
        mensagem: `Cortineiro com ${f2(prof.mul(100))} cm; ${comForroDuplo ? 'Wave com forro em trilho duplo' : 'Wave simples'} exige no mínimo ${f2(minimo.mul(100))} cm.`,
      });
    } else if (comForroDuplo && prof.lt('0.22')) {
      alertas.push({
        codigo: 'CORTINEIRO_NO_LIMITE',
        severidade: 'ATENCAO',
        mensagem: `Cortineiro com ${f2(prof.mul(100))} cm está na faixa mínima (18-22 cm) para Wave com forro. Verifique a folga das ondas.`,
      });
    }
  }

  return fecharResultado('CORTINA', comps, alertas, {
    larguraTrilho: f2(L),
    alturaPronta: f2(H),
    numFolhas: N,
    confeccao: e.confeccao,
    trilho: { sku: trilho.sku, vias: vias.toNumber(), varao: ehVarao, barras: barras.map((b) => ({ tamanhoM: f2(b.tamanho), quantidade: b.quantidade.toNumber() })) },
    tecido: fichaCorte(pTecido, fTecido, tec),
    forro: forro && e.forro ? fichaCorte(catalogo.obter(e.forro.sku), d(e.forro.fator), forro) : undefined,
  });
}

function fichaCorte(p: Produto, fator: Decimal, r: ResultadoTecido) {
  return {
    sku: p.sku,
    larguraRolo: f2(metaNum(p, 'largura_rolo')),
    fator: fator.toString(),
    modoCorte: r.modoCorte,
    alturaCorte: f2(r.alturaCorte),
    numTiras: r.numTiras?.toNumber(),
    consumoML: f2(r.quantidade),
  };
}

function alertaCorte(alertas: Alerta[], rotulo: string, r: ResultadoTecido, p: Produto) {
  if (r.modoCorte === 'VERTICAL_TIRAS') {
    alertas.push({
      codigo: 'CORTE_EM_TIRAS',
      severidade: 'INFO',
      mensagem: `${rotulo} (${p.sku}) em corte vertical: ${r.numTiras?.toString()} tira(s) com emendas verticais (H_corte ${f2(r.alturaCorte)}m).`,
    });
  }
}

export interface BarraTrilho {
  /** Comprimento da barra (m), múltiplo de `passo`. */
  tamanho: Decimal;
  quantidade: Decimal;
}

/**
 * Decompõe o comprimento em barras comerciais: barras de `barraMax` quantas couberem
 * e uma barra final com o resto arredondado para cima ao `passo`.
 * 1,50 -> [2 m]; 6,00 -> [6 m]; 6,10 -> [6 m, 1 m]; 12,50 -> [6 m x2, 1 m].
 */
export function decomporBarras(comprimento: Decimal, barraMax: Decimal, passo: Decimal): BarraTrilho[] {
  const inteiras = comprimento.div(barraMax).floor();
  const resto = ceilStep(comprimento.minus(inteiras.mul(barraMax)), passo);
  const out: BarraTrilho[] = [];
  if (inteiras.gt(0)) out.push({ tamanho: barraMax, quantidade: inteiras });
  if (resto.gt(0)) out.push({ tamanho: resto, quantidade: new Decimal(1) });
  return out;
}

function descreverBarras(barras: BarraTrilho[]): string {
  return barras.map((b) => `${b.quantidade.toString()} barra(s) de ${b.tamanho.toString()} m`).join(' + ');
}

type PrecoBarra = { custo: Numerico; venda: Numerico };

/**
 * Sem tabela `precos_barra` no SKU: 1 linha em ML (total de metros x preço do ML).
 * Com tabela (ex.: {"1": {"custo": 20, "venda": 55}, ..., "6": {...}}): 1 linha por
 * tamanho de barra, em PC, com o preço daquele tamanho (barra maior sai mais barata por metro).
 */
function componentesTrilho(trilho: Produto, barras: BarraTrilho[], log: string): ComponenteCalculado[] {
  const tabela = trilho.metadata?.['precos_barra'] as Record<string, PrecoBarra> | undefined;
  if (!tabela) {
    const metros = barras.reduce((s, b) => s.plus(b.tamanho.mul(b.quantidade)), ZERO);
    return [componente(trilho, metros, `${log} = ${f2(metros)} ML`)];
  }
  return barras.map((b) => {
    const chave = b.tamanho.toString();
    const preco = tabela[chave];
    if (!preco) throw new ErroEntrada(`SKU ${trilho.sku}: precos_barra sem preço para barra de ${chave} m`);
    const prodBarra: Produto = {
      ...trilho,
      nome: `${trilho.nome} - barra ${chave} m`,
      unidade: 'PC',
      custoUnitario: preco.custo,
      precoVendaUnitario: preco.venda,
    };
    return componente(prodBarra, b.quantidade, `${log}: ${b.quantidade.toString()} PC de ${chave} m`);
  });
}
