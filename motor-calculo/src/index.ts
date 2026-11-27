export { Decimal, d, ceilStep, dinheiro, ErroEntrada, type Numerico } from './decimal.js';
export type * from './tipos.js';
export { PRODUTOS_SEED, criarCatalogo, catalogoSeed } from './catalogo-seed.js';
export {
  calcularCortina,
  calcularTecidoML,
  calcularDeslizantesWave,
  calcularGarrasTrilho,
  calcularSuportesVarao,
  decomporBarras,
  type BarraTrilho,
  SKUS_CORTINA_PADRAO,
  type EntradaCortina,
  type CamadaTecido,
  type CamadaForro,
  type ModoCorte,
  type TipoConfeccao,
} from './cortina.js';
export {
  calcularPersiana,
  calcularAreaPersianaM2,
  medidaProducao,
  tuboRecomendado,
  SKUS_PERSIANA_PADRAO,
  FOLGAS_PADRAO,
  type EntradaPersiana,
  type Medida,
  type ModoInstalacao,
  type Acionamento,
} from './persiana.js';
export { resumirOrcamento, paraJSON, type ItemOrcamento, type ResumoOrcamento } from './orcamento.js';
export { lerPrecosBarraCSV, aplicarPrecosBarra, normalizarNumero, type LinhaPrecoBarra, type ResultadoPrecosBarra } from './precos-barra.js';
export { carregarCatalogo, CAMINHO_PRECOS_BARRA } from './carregar.js';
