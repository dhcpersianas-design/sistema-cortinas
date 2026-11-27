/**
 * Entrada para o navegador (PWA offline): tudo do motor, menos `carregarCatalogo`,
 * que lê arquivo do disco (node:fs). No app, o catálogo vem da API/cache local.
 *   import { calcularCortina } from '@sistema/motor-calculo/navegador';
 */
export { Decimal, d, ceilStep, dinheiro, ErroEntrada, type Numerico } from './decimal.js';
export type * from './tipos.js';
export { PRODUTOS_SEED, criarCatalogo, catalogoSeed } from './catalogo-seed.js';
export * from './cortina.js';
export * from './persiana.js';
export * from './orcamento.js';
export * from './precos-barra.js';
export * from './precificacao.js';
export * from './configurador.js';
