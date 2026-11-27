import type { Catalogo, Produto } from './tipos.js';
import { ErroEntrada } from './decimal.js';

/**
 * Catálogo de testes da seção 7/8 da especificação (valores FICTÍCIOS).
 * Em produção o catálogo vem do banco; isto serve para testes e protótipos.
 */
export const PRODUTOS_SEED: Produto[] = [
  { sku: 'TEC-001', nome: 'Linho Sintetico Gaze', unidade: 'ML', custoUnitario: '42.00', precoVendaUnitario: '110.00', metadata: { largura_rolo: 3.0, permite_corte_horizontal: true, eh_forro: false } },
  { sku: 'TEC-002', nome: 'Forro Microfibra 80%', unidade: 'ML', custoUnitario: '28.00', precoVendaUnitario: '75.00', metadata: { largura_rolo: 2.8, permite_corte_horizontal: true, eh_forro: true } },
  { sku: 'TEC-003', nome: 'Blackout Emborrachado 100%', unidade: 'ML', custoUnitario: '48.00', precoVendaUnitario: '125.00', metadata: { largura_rolo: 2.8, permite_corte_horizontal: true, eh_forro: true } },

  { sku: 'TRI-001', nome: 'Trilho Suico Max Simples', unidade: 'ML', custoUnitario: '16.00', precoVendaUnitario: '45.00', metadata: { vias: 1, min_ml: 1.0, barra_max: 6.0 } },
  { sku: 'TRI-002', nome: 'Trilho Suico Duplo Largo', unidade: 'ML', custoUnitario: '34.00', precoVendaUnitario: '89.00', metadata: { vias: 2, min_ml: 1.0, barra_max: 6.0 } },
  { sku: 'TRI-003', nome: 'Varao Aluminio 28mm Simples', unidade: 'ML', custoUnitario: '25.00', precoVendaUnitario: '68.00', metadata: { vias: 1, min_ml: 1.0, tipo: 'VARAO' } },

  { sku: 'DES-001', nome: 'Deslizante Wave c/ Cordao 6.7cm', unidade: 'UN', custoUnitario: '1.40', precoVendaUnitario: '3.80', metadata: { un_por_metro: 15, exige_par_folha: true } },
  { sku: 'DES-002', nome: 'Deslizante Max Comum', unidade: 'UN', custoUnitario: '0.35', precoVendaUnitario: '1.20', metadata: { un_por_metro: 10, exige_par_folha: false } },
  { sku: 'DES-003', nome: 'Fita Entretela Wave 8cm', unidade: 'ML', custoUnitario: '3.50', precoVendaUnitario: '10.00', metadata: { base_calculo: 'ML_TECIDO_PRINCIPAL' } },

  { sku: 'FIX-001', nome: 'FinalClick / Terminal Trilho', unidade: 'UN', custoUnitario: '2.50', precoVendaUnitario: '8.00', metadata: { qtd_por_via: 2 } },
  { sku: 'FIX-002', nome: 'Garra / Presilha Trilho Suico', unidade: 'UN', custoUnitario: '2.00', precoVendaUnitario: '6.50', metadata: { espacamento_m: 0.5, min_un: 2 } },
  { sku: 'FIX-003', nome: 'Emenda de Trilho Suico', unidade: 'PC', custoUnitario: '6.00', precoVendaUnitario: '18.00', metadata: { gatilho_largura_m: 3.0 } },

  { sku: 'MDO-001', nome: 'Confeccao Cortina Wave', unidade: 'ML', custoUnitario: '22.00', precoVendaUnitario: '55.00', metadata: { base: 'ML_TECIDO', fator_pe_direito_alto: 1.3 } },
  { sku: 'MDO-002', nome: 'Confeccao Forro Simples/Wave', unidade: 'ML', custoUnitario: '16.00', precoVendaUnitario: '40.00', metadata: { base: 'ML_TECIDO', fator_pe_direito_alto: 1.25 } },
  { sku: 'MDO-003', nome: 'Confeccao Prega Macho/Americana', unidade: 'ML', custoUnitario: '25.00', precoVendaUnitario: '62.00', metadata: { base: 'ML_TECIDO', fator_pe_direito_alto: 1.3 } },

  { sku: 'PER-001', nome: 'Persiana Rolo Tela Solar 3%', unidade: 'M2', custoUnitario: '135.00', precoVendaUnitario: '320.00', metadata: { larg_min: 0.0, alt_min: 1.2, area_min: 1.5, larg_max: 2.8 } },
  { sku: 'PER-002', nome: 'Persiana Rolo Blackout 100%', unidade: 'M2', custoUnitario: '145.00', precoVendaUnitario: '345.00', metadata: { larg_min: 0.0, alt_min: 1.2, area_min: 1.5, larg_max: 2.6 } },
  { sku: 'PER-003', nome: 'Persiana Double Vision', unidade: 'M2', custoUnitario: '210.00', precoVendaUnitario: '490.00', metadata: { larg_min: 0.0, alt_min: 1.2, area_min: 1.5, larg_max: 2.5 } },

  { sku: 'ACP-001', nome: 'Bando Aluminio Pint. Eletrost.', unidade: 'ML', custoUnitario: '52.00', precoVendaUnitario: '135.00', metadata: { min_ml: 1.0, base: 'LARGURA_PERSIANA' } },
  { sku: 'ACP-002', nome: 'Guia Lateral / Perfil U', unidade: 'ML', custoUnitario: '38.00', precoVendaUnitario: '95.00', metadata: { base: '2X_ALTURA_PERSIANA' } },
  { sku: 'ACP-003', nome: 'Redutor de Peso / Mola Alivio', unidade: 'PC', custoUnitario: '65.00', precoVendaUnitario: '160.00', metadata: { sugerir_largura_maior_m: 2.4 } },

  { sku: 'MOT-001', nome: 'Motor Tubular X Bivolt RF 6Nm', unidade: 'PC', custoUnitario: '480.00', precoVendaUnitario: '1150.00', metadata: { torque_nm: 6, tubo_compat: ['38mm', '45mm'] } },
  { sku: 'MOT-002', nome: 'Controle Remoto RF 5 Canais', unidade: 'PC', custoUnitario: '75.00', precoVendaUnitario: '190.00', metadata: { canais: 5, escopo: 'AMBIENTE_OU_ORCAMENTO' } },
  { sku: 'MOT-003', nome: 'Hub Wi-Fi Alexa / Google Home', unidade: 'PC', custoUnitario: '190.00', precoVendaUnitario: '450.00', metadata: { escopo: 'ORCAMENTO' } },

  { sku: 'SRV-001', nome: 'Instalacao Cortina ate 3,00m', unidade: 'UN', custoUnitario: '80.00', precoVendaUnitario: '180.00', metadata: { tipo: 'CORTINA' } },
  { sku: 'SRV-002', nome: 'Instalacao Persiana Manual', unidade: 'PC', custoUnitario: '60.00', precoVendaUnitario: '140.00', metadata: { tipo: 'PERSIANA_MANUAL' } },
  { sku: 'SRV-003', nome: 'Instalacao Persiana Motorizada', unidade: 'PC', custoUnitario: '110.00', precoVendaUnitario: '250.00', metadata: { tipo: 'PERSIANA_MOTORIZADA' } },
];

export function criarCatalogo(produtos: Produto[]): Catalogo {
  const mapa = new Map(produtos.map((p) => [p.sku, p]));
  return {
    obter(sku: string): Produto {
      const p = mapa.get(sku);
      if (!p) throw new ErroEntrada(`SKU não encontrado no catálogo: ${sku}`);
      return p;
    },
  };
}

export const catalogoSeed: Catalogo = criarCatalogo(PRODUTOS_SEED);
