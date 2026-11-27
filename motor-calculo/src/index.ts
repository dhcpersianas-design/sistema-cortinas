export { Decimal, d, ceilStep, dinheiro, ErroEntrada, ErroSkuNaoEncontrado, type Numerico } from './decimal.js';
export type * from './tipos.js';
export { PRODUTOS_SEED, criarCatalogo, catalogoSeed } from './catalogo-seed.js';
export {
  calcularCortina,
  precoTrilhoMotorizado,
  type FaixaTrilhoMotorizado,
  calcularTecidoML,
  calcularDeslizantesWave,
  calcularGarrasTrilho,
  calcularSuportesVarao,
  decomporBarras,
  type BarraTrilho,
  SKUS_CORTINA_PADRAO,
  FATOR_PADRAO,
  FATOR_FORRO_PADRAO,
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
export { precoVendaSugerido, semaforoMargem, MARKUP_PADRAO_PCT, LIMITES_SEMAFORO_PADRAO, type CorSemaforo, type LimitesSemaforo } from './precificacao.js';
export {
  calcularItem, calcularServico, type EntradaServico, aplicarAjustes, descricaoComercial, garantiaMesesProduto, garantiaDoItem, textoGarantia, sugerirControles,
  type GarantiaItem, type OpcaoControle, ratear, ratearDesconto, totalizarOrcamento, checarLiberacao, tetoDesconto, descontoValeNaForma, type TetoDesconto,
  type EntradaItem, type Ajuste, type ComponenteItem, type ResultadoItem, type LinhaParaRateio,
  type CondicoesOrcamento, type ParametrosMargem, type TotaisOrcamento, type ChecagemLiberacao,
} from './configurador.js';
export { regrasDoModelo, type RegraModelo, type ModeloEscolhido } from './regras.js';
export { MODELOS_CADASTRO, ALTERACAO_EM_MASSA, modeloCadastro, metadataDosCampos, type PerfilCadastro, type CampoTecnico, type ModeloCadastro } from './cadastro.js';
export { STATUS_DISPONIBILIDADE, ROTULO_DISPONIBILIDADE, alertasDisponibilidade, textoDisponibilidade, dataBr, type StatusDisponibilidade } from './disponibilidade.js';
export {
  MODELOS_ACIONAMENTO, adicionaisDoModelo, acionamentosDoModelo, avisosDoModelo, limitesDoModelo, adicionaisAplicados, textoAdicional,
  type AdicionalModelo, type LimitesModelo, type TipoAdicional,
} from './linha-persiana.js';
