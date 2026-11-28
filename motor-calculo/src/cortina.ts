import { Decimal, ceilStep, d, ErroEntrada, naoNegativo, positivo, ZERO, type Numerico } from './decimal.js';
import { componente, f2, fecharResultado, metaBool, metaNum, metaStr, obterAuxiliar } from './comum.js';
import type { Alerta, Catalogo, ComponenteCalculado, Produto, ResultadoCalculo } from './tipos.js';

export type ModoCorte = 'HORIZONTAL' | 'VERTICAL_TIRAS';
/** PREGA = prega macho. FRANZIDO usa deslizantes comuns, como a prega (sem fita wave). */
export type TipoConfeccao = 'WAVE' | 'PREGA' | 'FRANZIDO';

/**
 * Fator de franzimento padrão (Gabriel, 27/11/2026): tecido principal wave 2,8,
 * prega macho 3,0, franzido 2,5; tecido secundário (forro) franzido 1,8.
 * Vale quando o vendedor não informa o fator.
 */
export const FATOR_PADRAO: Record<TipoConfeccao, string> = { WAVE: '2.8', PREGA: '3.0', FRANZIDO: '2.5' };
export const FATOR_FORRO_PADRAO = '1.8';

export interface CamadaTecido {
  sku: string;
  /** Fator de franzimento (ex.: 2.5). Em branco: FATOR_PADRAO da confecção (forro: 1,8). */
  fator?: Numerico;
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
  /** Controle remoto da cortina motorizada. */
  controle?: string;
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

/**
 * Modelo pronto de cortina (Gabriel, 28/11/2026): o administrador escolhe os acessórios de cada
 * tecido e da cortina; o vendedor puxa o modelo no orçamento e o cálculo usa ESTES produtos
 * (não os códigos fixos DES-001, FIX-001...). O item guarda uma cópia do modelo.
 */
export type AplicaAcessorio = 'PRIMARIO' | 'SECUNDARIO' | 'CORTINA';
/**
 * Como calcula a quantidade:
 * - DESLIZANTE: tecido wave = largura do trilho em cm / 4; franzido (e o secundário) = cm / 8; sobe ao número PAR.
 * - ENTRETELA: só cortina wave e só no tecido primário = metros do tecido (largura x fator).
 * - TERMINAL: 6 por cortina (por janela, não por tecido).
 * - GARRA: 1 em cada ponta + 1 a cada 40 cm = CEIL(largura / 0,40) + 1 (simples, dupla ou tripla).
 * - ML_TECIDO: metros do tecido a que o acessório pertence. ML_TRILHO: metros do trilho. FIXA: quantidade fixa.
 */
export type RegraAcessorio = 'DESLIZANTE' | 'ENTRETELA' | 'TERMINAL' | 'GARRA' | 'ML_TECIDO' | 'ML_TRILHO' | 'FIXA';
export const REGRAS_ACESSORIO: Record<RegraAcessorio, string> = {
  DESLIZANTE: 'Deslizante (wave cm/4, franzido cm/8, par)',
  ENTRETELA: 'Entretela (= metros do tecido)',
  TERMINAL: 'Terminal (6 por cortina)',
  GARRA: 'Garra (pontas + 1 a cada 40 cm)',
  ML_TECIDO: 'Metros do tecido',
  ML_TRILHO: 'Metros do trilho',
  FIXA: 'Quantidade fixa por cortina',
};
export interface AcessorioModelo {
  sku: string;
  aplica: AplicaAcessorio;
  regra: RegraAcessorio;
  /** Só na regra FIXA (padrão 1). */
  quantidade?: Numerico;
}
export interface ModeloCortinaItem {
  id?: string;
  nome: string;
  acessorios: AcessorioModelo[];
  /** Mão de obra da confecção da cortina inteira (todos os tecidos) = valor x largura do trilho. */
  maoObra?: string;
  /** Instalação até 3 m e acima de 3 m (em branco: SRV-001 / SRV-004). */
  instalacao?: string;
  instalacaoAcima3m?: string;
}

/** Arredonda para cima ao número par (62,5 -> 64; 31,25 -> 32). */
export function parAcima(x: Decimal): Decimal {
  const c = x.ceil();
  return c.mod(2).isZero() ? c : c.plus(1);
}

/** Deslizantes da regra do Gabriel: wave = cm / 4, franzido/prega = cm / 8, sempre par. */
export function deslizantesModelo(larguraTrilho: Decimal, wave: boolean) {
  const cm = larguraTrilho.mul(100);
  const div = wave ? 4 : 8;
  const q = parAcima(cm.div(div));
  return { quantidade: q, log: `${wave ? 'Wave' : 'Franzido'}: ${cm.toFixed(0)} cm / ${div} = ${cm.div(div).toDecimalPlaces(2).toString()} -> par acima = ${q.toString()} UN` };
}

/** Garras: 1 em cada ponta + 1 a cada 40 cm (2,50 m -> 8; 1,60 m -> 5). */
export function garrasModelo(larguraTrilho: Decimal) {
  const q = larguraTrilho.div('0.40').ceil().plus(1);
  return { quantidade: q, log: `CEIL(${f2(larguraTrilho)} / 0,40) + 1 = ${q.toString()} UN (pontas + 1 a cada 40 cm)` };
}

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
  /**
   * Cortina motorizada (Gabriel, 27/11/2026): SKU do trilho motorizado (Slim). É o sistema completo,
   * trilho pronto com motor: substitui trilho comum, deslizantes, terminais e garras. Preço pela
   * faixa de largura (`metadata.faixas`), máximo 12 m (acima não fabrica).
   */
  trilhoMotorizado?: string;
  /** Controles remotos neste item (só cortina motorizada; não vêm com o trilho). Padrão 1. */
  qtdControles?: number;
  /** Modelo pronto: acessórios e mão de obra vêm daqui, no lugar dos códigos fixos. */
  modelo?: ModeloCortinaItem;
}

/** Faixa de preço do trilho motorizado: vale a primeira com `ate` >= largura. */
export interface FaixaTrilhoMotorizado { ate: number; custo: number; sku?: string }

/** Uma faixa = um produto do catálogo (Gabriel, 28/11/2026): `metadata.faixas_skus` lista as faixas da família. */
interface FaixaSku { ate: number; sku: string }

function faixasSkus(p: Produto): FaixaSku[] {
  return ((p.metadata?.['faixas_skus'] ?? []) as FaixaSku[])
    .filter((f) => Number.isFinite(Number(f?.ate)) && typeof f?.sku === 'string')
    .sort((a, b) => Number(a.ate) - Number(b.ate));
}

/**
 * Trilho motorizado pela largura. Cada faixa é um produto ("TRILHO MOTORIZADO - WAVE - ATÉ 4,50 MT - BRANCO"):
 * o vendedor escolhe modelo e cor e o sistema troca para o produto da faixa que atende a largura
 * (4,35 m -> ATÉ 4,50; 4,00 m -> ATÉ 4,00). Máximo = maior faixa (12 m). Formato antigo
 * (`metadata.faixas` com custo dentro de um produto só) continua aceito.
 */
export function precoTrilhoMotorizado(p: Produto, largura: Decimal, catalogo?: Catalogo): { faixa: FaixaTrilhoMotorizado; produto: Produto; custo: Decimal; venda: Decimal } {
  const porSku = faixasSkus(p);
  if (porSku.length > 0 && catalogo) {
    const faixa = porSku.find((f) => largura.lte(f.ate));
    const max = porSku[porSku.length - 1]!.ate;
    if (!faixa) throw new ErroEntrada(`${p.nome}: largura ${f2(largura)} m acima do máximo de ${f2(d(max))} m (a fábrica não produz). Divida em mais cortinas.`);
    const prod = faixa.sku === p.sku ? p : catalogo.obter(faixa.sku);
    return { faixa: { ate: Number(faixa.ate), custo: Number(prod.custoUnitario), sku: prod.sku }, produto: prod, custo: d(prod.custoUnitario), venda: d(prod.precoVendaUnitario) };
  }
  const faixas = ((p.metadata?.['faixas'] ?? []) as FaixaTrilhoMotorizado[])
    .filter((f) => Number.isFinite(Number(f?.ate)) && Number.isFinite(Number(f?.custo)))
    .sort((a, b) => Number(a.ate) - Number(b.ate));
  if (faixas.length === 0) {
    const ate = p.metadata?.['faixa_ate'];
    if (ate !== undefined && Number.isFinite(Number(ate))) {
      if (largura.gt(Number(ate))) throw new ErroEntrada(`${p.nome}: largura ${f2(largura)} m maior que a faixa deste trilho (até ${f2(d(Number(ate)))} m). Escolha a faixa maior.`);
      return { faixa: { ate: Number(ate), custo: Number(p.custoUnitario), sku: p.sku }, produto: p, custo: d(p.custoUnitario), venda: d(p.precoVendaUnitario) };
    }
    throw new ErroEntrada(`${p.nome}: cadastre as faixas de preço por largura.`);
  }
  const faixa = faixas.find((f) => largura.lte(f.ate));
  const max = faixas[faixas.length - 1]!.ate;
  if (!faixa) throw new ErroEntrada(`${p.nome}: largura ${f2(largura)} m acima do máximo de ${f2(d(max))} m (a fábrica não produz). Divida em mais cortinas.`);
  const custoTab = d(p.custoUnitario);
  const fator = custoTab.gt(0) ? d(p.precoVendaUnitario).div(custoTab) : new Decimal(1);
  const custo = d(faixa.custo);
  return { faixa, produto: p, custo, venda: custo.mul(fator).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) };
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
  if (!(e.confeccao in FATOR_PADRAO)) throw new ErroEntrada('confeccao deve ser WAVE, PREGA ou FRANZIDO');
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

  let pMotor = e.trilhoMotorizado ? catalogo.obter(e.trilhoMotorizado) : undefined;
  const trilho = pMotor ? undefined : obterAuxiliar(catalogo, skus.trilho, alertas, 'O trilho/varão');
  const ehVarao = trilho ? metaStr(trilho, 'tipo') === 'VARAO' : false;
  const vias = pMotor ? metaNum(pMotor, 'vias', 1) : trilho ? metaNum(trilho, 'vias', 1) : new Decimal(e.forro ? 2 : 1);
  const peDireitoAlto = H.gt(limitePD);

  // ---------- Passo A: tecido principal ----------
  const pTecido = catalogo.obter(e.tecido.sku);
  const fTecido = positivo('tecido.fator', e.tecido.fator ?? FATOR_PADRAO[e.confeccao]);
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
      fator: positivo('forro.fator', e.forro.fator ?? FATOR_FORRO_PADRAO),
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
    if ((trilho || pMotor) && vias.lt(2)) {
      alertas.push({
        codigo: 'FORRO_SEM_VIA',
        severidade: 'ATENCAO',
        mensagem: 'Cortina com forro em trilho/varão de 1 via. Use trilho duplo para o forro correr separado.',
      });
    }
  }

  // ---------- Passo B1: mão de obra ----------
  const minTrilho = trilho ? metaNum(trilho, 'min_ml', '1.00') : new Decimal('1.00');
  const lTrilhoReal = Decimal.max(L, minTrilho).toDecimalPlaces(2, Decimal.ROUND_UP);
  const mdo = (sku: string, qTecido: Decimal, rotulo: string) => {
    const p = obterAuxiliar(catalogo, sku, alertas, `A confecção (mão de obra do ${rotulo})`);
    if (!p) return;
    const base = e.baseMaoObra ?? (metaStr(p, 'base') === 'ML_TRILHO' ? 'ML_TRILHO' : 'ML_TECIDO');
    const qtd = base === 'ML_TRILHO' ? lTrilhoReal : qTecido;
    const mult = peDireitoAlto ? metaNum(p, 'fator_pe_direito_alto', '1.30') : new Decimal(1);
    const txtMult = peDireitoAlto ? ` x adicional pé-direito alto ${mult.toString()}` : '';
    comps.push(componente(p, qtd, `MDO ${rotulo} base ${base} = ${f2(qtd)} ML${txtMult}`, mult));
  };
  const modelo = e.modelo;
  if (modelo) {
    // Modelo: um serviço para a cortina inteira (todos os tecidos) = valor x largura do trilho.
    if (modelo.maoObra) {
      const p = obterAuxiliar(catalogo, modelo.maoObra, alertas, 'A confecção (mão de obra)');
      if (p) comps.push(componente(p, L, `Confecção da cortina inteira: largura do trilho ${f2(L)} m x valor do serviço`));
    }
  } else {
    mdo(skus.maoObraTecido, tec.quantidade, 'tecido');
    if (forro) mdo(skus.maoObraForro, forro.quantidade, 'forro');
  }
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
  const passoBarra = trilho ? metaNum(trilho, 'passo_venda_m', '1.00') : new Decimal('1.00');
  const barraMax = trilho ? metaNum(trilho, 'barra_max', '6.00') : new Decimal('6.00');
  const barras = decomporBarras(lTrilhoReal, barraMax, passoBarra);
  const qTrilho = barras.reduce((s, b) => s.plus(b.tamanho.mul(b.quantidade)), ZERO);
  const txtBarras = descreverBarras(barras);
  if (trilho) comps.push(...componentesTrilho(trilho, barras, `Barras: MAX(L_trilho ${f2(L)}, mín ${f2(minTrilho)}) -> ${txtBarras}`));
  const totalBarras = barras.reduce((s, b) => s + b.quantidade.toNumber(), 0);
  if (trilho && totalBarras > 1) {
    alertas.push({
      codigo: 'TRILHO_ACIMA_BARRA_MAX',
      severidade: 'ATENCAO',
      mensagem: `Trilho de ${f2(L)}m excede a barra máxima de ${f2(barraMax)}m: ${txtBarras} (${f2(qTrilho)} m). Emenda não incluída; confirme a divisão com o instalador.`,
    });
  }

  // ---------- Trilho motorizado (sistema completo: trilho + motor) ----------
  let faixaMotor: FaixaTrilhoMotorizado | undefined;
  if (pMotor) {
    const preco = precoTrilhoMotorizado(pMotor, L, catalogo);
    faixaMotor = preco.faixa;
    pMotor = preco.produto;
    comps.push(componente({ ...preco.produto, custoUnitario: preco.custo, precoVendaUnitario: preco.venda }, new Decimal(1),
      `Trilho motorizado: largura ${f2(L)} m -> faixa até ${f2(d(preco.faixa.ate))} m`));
    const modeloMotor = metaStr(pMotor, 'modelo');
    const precisa = e.confeccao === 'WAVE' ? 'WAVE' : 'FRANZIDA';
    if (modeloMotor && modeloMotor !== precisa) {
      alertas.push({ codigo: 'TRILHO_MOTORIZADO_MODELO', severidade: 'CRITICO',
        mensagem: `Cortina ${e.confeccao === 'WAVE' ? 'Wave' : 'franzida/prega'} pede o trilho motorizado modelo ${precisa === 'WAVE' ? 'Wave (botão)' : 'Standard (franzida)'}; o escolhido é ${modeloMotor === 'WAVE' ? 'Wave' : 'Standard'}.` });
    }
    const qc = e.qtdControles ?? 1;
    if (qc > 0) {
      const pc = obterAuxiliar(catalogo, skus.controle ?? 'MOT-002', alertas, 'O controle remoto (não vem com o trilho)');
      if (pc) comps.push(componente(pc, new Decimal(qc), `${qc} PC (controle remoto não incluso no trilho)`));
    }
  }

  if (modelo) {
    acessoriosModelo(modelo, { L, passo, fTecido, tec, forro, confeccao: e.confeccao, motorizado: Boolean(pMotor), catalogo, alertas, comps });
  } else {
    // ---------- Passo B3/B4: deslizantes ----------
    if (e.confeccao === 'WAVE' && !pMotor) {
      if (ehVarao) {
        alertas.push({
          codigo: 'WAVE_EM_VARAO',
          severidade: 'CRITICO',
          mensagem: 'Cortina Wave exige trilho com deslizantes e cordão espaçador; não é compatível com varão.',
        });
      }
      const pW = obterAuxiliar(catalogo, skus.deslizanteWave, alertas, 'O deslizante wave');
      if (pW) {
        const w = calcularDeslizantesWave(L, N, metaNum(pW, 'un_por_metro', 15));
        comps.push(componente(pW, w.quantidade, w.log));
      }
    }
    const camadasComum = (e.confeccao !== 'WAVE' ? 1 : 0) + (forro ? 1 : 0);
    const pComum = camadasComum > 0 && !ehVarao && !pMotor ? obterAuxiliar(catalogo, skus.deslizanteComum, alertas, 'O deslizante comum') : undefined;
    if (pComum) {
      const upmComum = metaNum(pComum, 'un_por_metro', 10);
      const porCamada = L.mul(upmComum).ceil();
      const total = porCamada.mul(camadasComum);
      comps.push(componente(pComum, total, `CEIL(${f2(L)} * ${upmComum.toString()} un/m) * ${camadasComum} camada(s) = ${total.toString()} UN`));
    }

    // ---------- Passo B5: fita entretela wave ----------
    if (e.confeccao === 'WAVE') {
      const pFita = obterAuxiliar(catalogo, skus.fitaWave, alertas, 'A fita entretela wave');
      const qFita = tec.modoCorte === 'HORIZONTAL' ? tec.quantidade : ceilStep(L.mul(fTecido), passo);
      const log = tec.modoCorte === 'HORIZONTAL'
        ? `= ML tecido principal (corte horizontal) = ${f2(qFita)} ML`
        : `CEIL((${f2(L)} * ${fTecido.toString()}) / ${passo.toString()}) * ${passo.toString()} = ${f2(qFita)} ML`;
      if (pFita) comps.push(componente(pFita, qFita, log));
    }

    // ---------- Passo B6/B7: terminais e fixação ----------
    const pTerm = !ehVarao && !pMotor ? obterAuxiliar(catalogo, skus.terminal, alertas, 'O terminal do trilho') : undefined;
    if (pTerm) {
      const porVia = metaNum(pTerm, 'qtd_por_via', 2);
      const qTerm = porVia.mul(vias);
      comps.push(componente(pTerm, qTerm, `${porVia.toString()} * ${vias.toString()} via(s) = ${qTerm.toString()} UN`));
    }
    const pFix = pMotor ? undefined : obterAuxiliar(catalogo, skus.fixacao, alertas, 'A fixação (garras/suportes)');
    if (pFix) {
      const fix = ehVarao
        ? calcularSuportesVarao(L)
        : calcularGarrasTrilho(L, metaNum(pFix, 'espacamento_m', '0.50'), metaNum(pFix, 'min_un', 2));
      comps.push(componente(pFix, fix.quantidade, fix.log));
    }
  }

  // ---------- Passo B8: instalação (faixas v1.1) ----------
  // Até 3,00 m: SRV-001. Acima: SRV-004 (sem tamanho máximo; 2x o valor de SRV-001).
  const acima3 = L.gt(3);
  const skuInst = acima3 ? (modelo?.instalacaoAcima3m || skus.instalacaoAcima3m) : (modelo?.instalacao || skus.instalacao);
  const pInst = obterAuxiliar(catalogo, skuInst, alertas,
    acima3 ? 'A instalação de cortina acima de 3 m' : 'A instalação de cortina');
  if (pInst) comps.push(componente(pInst, new Decimal(1), `1 UN por cortina (trilho ${f2(L)}m ${acima3 ? '> 3,00m' : '<= 3,00m'})`));
  if (acima3) {
    alertas.push({ codigo: 'INSTALACAO_ACIMA_3M', severidade: 'INFO',
      mensagem: `Trilho de ${f2(L)}m (acima de 3,00m): entra a instalação de cortina acima de 3 m (valor maior).` });
  }
  if (peDireitoAlto) {
    const pPD = obterAuxiliar(catalogo, skus.adicionalPeDireitoAlto, alertas, 'O adicional de andaime/escada');
    if (pPD) comps.push(componente(pPD, new Decimal(1), `Adicional andaime/escada: H_pronta ${f2(H)}m > ${f2(limitePD)}m`));
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
    modelo: modelo ? { id: modelo.id, nome: modelo.nome } : undefined,
    trilhoMotorizado: pMotor ? { sku: pMotor.sku, modelo: metaStr(pMotor, 'modelo'), cor: metaStr(pMotor, 'cor'), faixaAteM: faixaMotor?.ate } : undefined,
    trilho: pMotor ? undefined : { sku: trilho?.sku ?? skus.trilho, vias: vias.toNumber(), varao: ehVarao, barras: barras.map((b) => ({ tamanhoM: f2(b.tamanho), quantidade: b.quantidade.toNumber() })) },
    tecido: fichaCorte(pTecido, fTecido, tec),
    forro: forro && e.forro ? fichaCorte(catalogo.obter(e.forro.sku), d(e.forro.fator ?? FATOR_FORRO_PADRAO), forro) : undefined,
  });
}

/** Acessórios do modelo pronto (regras do Gabriel, 28/11/2026). */
function acessoriosModelo(modelo: ModeloCortinaItem, c: {
  L: Decimal; passo: Decimal; fTecido: Decimal; tec: ResultadoTecido; forro?: ResultadoTecido; confeccao: TipoConfeccao;
  motorizado: boolean; catalogo: Catalogo; alertas: Alerta[]; comps: ComponenteCalculado[];
}) {
  const { L, catalogo, alertas, comps } = c;
  const wave = c.confeccao === 'WAVE';
  for (const a of modelo.acessorios) {
    if (a.aplica === 'SECUNDARIO' && !c.forro) continue;
    // Trilho motorizado já vem com deslizantes, terminais e garras.
    if (c.motorizado && (a.regra === 'DESLIZANTE' || a.regra === 'TERMINAL' || a.regra === 'GARRA')) continue;
    if (a.regra === 'ENTRETELA' && (!wave || a.aplica !== 'PRIMARIO')) continue;
    const p = obterAuxiliar(catalogo, a.sku, alertas, `O acessório ${a.sku} do modelo`);
    if (!p) continue;
    const camada = a.aplica === 'SECUNDARIO' ? 'tecido secundário' : a.aplica === 'PRIMARIO' ? 'tecido primário' : 'cortina';
    let q: { quantidade: Decimal; log: string };
    switch (a.regra) {
      case 'DESLIZANTE': {
        // Secundário é sempre franzido; o primário segue a confecção do modelo.
        const r = deslizantesModelo(L, a.aplica !== 'SECUNDARIO' && wave);
        q = { quantidade: r.quantidade, log: `Deslizante do ${camada}. ${r.log}` };
        break;
      }
      case 'ENTRETELA': {
        const m = ceilStep(L.mul(c.fTecido), c.passo);
        q = { quantidade: m, log: `Entretela = metros do tecido primário: ${f2(L)} x ${c.fTecido.toString()} = ${f2(m)} ML` };
        break;
      }
      case 'TERMINAL':
        q = { quantidade: new Decimal(6), log: '6 UN por cortina' };
        break;
      case 'GARRA':
        q = garrasModelo(L);
        break;
      case 'ML_TECIDO': {
        const r = a.aplica === 'SECUNDARIO' ? c.forro! : c.tec;
        q = { quantidade: r.quantidade, log: `= metros do ${a.aplica === 'SECUNDARIO' ? 'tecido secundário' : 'tecido primário'} (${f2(r.quantidade)} ML)` };
        break;
      }
      case 'ML_TRILHO':
        q = { quantidade: L, log: `= largura do trilho (${f2(L)} m)` };
        break;
      default: {
        const n = positivo('quantidade do acessório', a.quantidade ?? 1);
        q = { quantidade: n, log: `${n.toString()} por cortina (fixo no modelo)` };
      }
    }
    comps.push(componente(p, q.quantidade, q.log));
  }
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
