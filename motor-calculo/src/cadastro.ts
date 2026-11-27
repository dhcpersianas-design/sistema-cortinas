/**
 * Campos do cadastro de produto por tipo (perfil da categoria), pedido do Gabriel em 27/11/2026:
 * ao escolher a categoria/subcategoria, a tela mostra só os dados técnicos que o cálculo usa
 * para aquele tipo de produto. As chaves são as da `metadata_tecnica` lidas pelo motor
 * (persiana.ts, cortina.ts, regras.ts, configurador.ts). Nada aqui muda o cálculo.
 */
import type { UnidadeMedida } from './tipos.js';

export type PerfilCadastro =
  | 'PERSIANA' | 'TECIDO' | 'ACESSORIO_PERSIANA' | 'MOTORIZACAO'
  | 'ACESSORIO_CORTINA' | 'TRILHO' | 'DESLIZANTE' | 'FIXACAO'
  | 'CONFECCAO' | 'INSTALACAO' | 'GENERICO';

export interface CampoTecnico {
  chave: string;
  rotulo: string;
  tipo: 'numero' | 'inteiro' | 'simnao' | 'opcoes';
  /** Para `opcoes`: [valor, rótulo]. Valor vazio = não preencher. */
  opcoes?: [string, string][];
  obrigatorio?: boolean;
  /** Unidade mostrada ao lado do campo (m, m², meses...). */
  sufixo?: string;
  dica?: string;
}

export interface ModeloCadastro {
  perfil: PerfilCadastro;
  unidadePadrao: UnidadeMedida;
  /** Texto curto sobre o que é este tipo de produto. */
  descricao: string;
  /** Rótulo do campo Cor/Coleção para este tipo. */
  rotuloCor: string;
  exemploNome: string;
  campos: CampoTecnico[];
}

const garantia = (padrao: string): CampoTecnico => ({
  chave: 'garantia_meses', rotulo: 'Garantia', tipo: 'inteiro', sufixo: 'meses',
  dica: `Em branco = ${padrao}.`,
});

export const MODELOS_CADASTRO: Record<PerfilCadastro, ModeloCadastro> = {
  PERSIANA: {
    perfil: 'PERSIANA', unidadePadrao: 'M2', rotuloCor: 'Coleção / cor', exemploNome: 'Rolo Tela Solar 3%',
    descricao: 'Persiana sob medida, cobrada por m². As medidas abaixo viram regras e alertas para o vendedor no orçamento.',
    campos: [
      { chave: 'larg_min', rotulo: 'Largura mínima cobrada', tipo: 'numero', sufixo: 'm', dica: 'Peça mais estreita é cobrada por esta largura.' },
      { chave: 'larg_max', rotulo: 'Largura máxima', tipo: 'numero', sufixo: 'm', dica: 'Acima disso o vendedor é avisado para dividir o vão.' },
      { chave: 'alt_min', rotulo: 'Altura mínima cobrada', tipo: 'numero', sufixo: 'm', dica: 'Peça mais baixa é cobrada por esta altura.' },
      { chave: 'alt_max', rotulo: 'Altura máxima', tipo: 'numero', sufixo: 'm', dica: 'Acima disso o vendedor é avisado para consultar a fábrica.' },
      { chave: 'area_min', rotulo: 'Área mínima cobrada', tipo: 'numero', sufixo: 'm²', dica: 'Peça menor é cobrada por esta área.' },
      garantia('12 meses (Rolo, Double Vision e Painel: 24 meses; Caixa Box e Shangrilá: 12)'),
    ],
  },
  TECIDO: {
    perfil: 'TECIDO', unidadePadrao: 'ML', rotuloCor: 'Cor', exemploNome: 'Linho Sintético',
    descricao: 'Tecido de cortina ou forro, comprado por metro linear.',
    campos: [
      { chave: 'largura_rolo', rotulo: 'Largura do rolo', tipo: 'numero', sufixo: 'm', obrigatorio: true, dica: 'Ex.: 2,80 ou 3,00. Usada no cálculo do corte.' },
      { chave: 'eh_forro', rotulo: 'É forro / blackout (aparece na lista de forros)?', tipo: 'simnao' },
      { chave: 'permite_corte_horizontal', rotulo: 'Pode virar o tecido (corte na horizontal)?', tipo: 'simnao', dica: 'Sim = sem emendas quando a altura cabe na largura do rolo.' },
      garantia('12 meses'),
    ],
  },
  ACESSORIO_PERSIANA: {
    perfil: 'ACESSORIO_PERSIANA', unidadePadrao: 'PC', rotuloCor: 'Cor / acabamento', exemploNome: 'Garradeira Rolo',
    descricao: 'Peça ou acabamento de persiana (bandô, guia, garradeira, tampa, suporte...).',
    campos: [
      { chave: 'base', rotulo: 'Como calcula a quantidade', tipo: 'opcoes', opcoes: [['', 'Escolhida à mão'], ['LARGURA_PERSIANA', 'Pela largura da persiana'], ['2X_ALTURA_PERSIANA', '2 vezes a altura (guias laterais)']] },
      { chave: 'min_ml', rotulo: 'Mínimo cobrado', tipo: 'numero', sufixo: 'm' },
    ],
  },
  MOTORIZACAO: {
    perfil: 'MOTORIZACAO', unidadePadrao: 'PC', rotuloCor: 'Modelo', exemploNome: 'Motor Tubular 6Nm',
    descricao: 'Motor, controle remoto ou automação.',
    campos: [
      { chave: 'torque_nm', rotulo: 'Torque (só motor)', tipo: 'numero', sufixo: 'Nm' },
      { chave: 'canais', rotulo: 'Canais (só controle remoto)', tipo: 'inteiro', dica: '1 canal aciona 1 peça. Controles com canais aparecem na escolha do orçamento.' },
      garantia('60 meses para motores, 12 para o resto'),
    ],
  },
  ACESSORIO_CORTINA: {
    perfil: 'ACESSORIO_CORTINA', unidadePadrao: 'UN', rotuloCor: 'Cor / acabamento', exemploNome: 'Suporte Simples Varão Suíço',
    descricao: 'Acessório de cortina.',
    campos: [],
  },
  TRILHO: {
    perfil: 'TRILHO', unidadePadrao: 'ML', rotuloCor: 'Cor', exemploNome: 'Trilho Suíço Simples',
    descricao: 'Trilho ou varão. Depois de salvar, preencha o preço por tamanho de barra (1 a 6 m).',
    campos: [
      { chave: 'tipo', rotulo: 'Tipo', tipo: 'opcoes', opcoes: [['', 'Trilho'], ['VARAO', 'Varão']] },
      { chave: 'vias', rotulo: 'Vias', tipo: 'opcoes', opcoes: [['1', '1 via (simples)'], ['2', '2 vias (duplo)']], obrigatorio: true },
      { chave: 'min_ml', rotulo: 'Mínimo cobrado', tipo: 'numero', sufixo: 'm' },
      { chave: 'barra_max', rotulo: 'Barra máxima', tipo: 'numero', sufixo: 'm', dica: 'Em branco = 6 m.' },
    ],
  },
  DESLIZANTE: {
    perfil: 'DESLIZANTE', unidadePadrao: 'UN', rotuloCor: 'Cor', exemploNome: 'Deslizante Wave',
    descricao: 'Deslizante, fita ou entretela.',
    campos: [
      { chave: 'un_por_metro', rotulo: 'Unidades por metro (deslizante)', tipo: 'inteiro' },
      { chave: 'exige_par_folha', rotulo: 'Precisa de número par por folha (wave)?', tipo: 'simnao' },
      { chave: 'base_calculo', rotulo: 'Fita / entretela', tipo: 'opcoes', opcoes: [['', 'Não é fita'], ['ML_TECIDO_PRINCIPAL', 'Calcula pelo metro do tecido principal']] },
    ],
  },
  FIXACAO: {
    perfil: 'FIXACAO', unidadePadrao: 'UN', rotuloCor: 'Cor', exemploNome: 'FinalClick',
    descricao: 'Terminal, garra, suporte ou emenda de trilho.',
    campos: [
      { chave: 'qtd_por_via', rotulo: 'Quantidade por via (terminal)', tipo: 'inteiro' },
      { chave: 'espacamento_m', rotulo: 'Espaçamento (garras/suportes)', tipo: 'numero', sufixo: 'm' },
      { chave: 'min_un', rotulo: 'Quantidade mínima', tipo: 'inteiro' },
    ],
  },
  CONFECCAO: {
    perfil: 'CONFECCAO', unidadePadrao: 'ML', rotuloCor: 'Detalhe', exemploNome: 'Confecção Cortina Wave',
    descricao: 'Mão de obra da costureira.',
    campos: [
      { chave: 'base', rotulo: 'Cobra por metro de', tipo: 'opcoes', opcoes: [['ML_TECIDO', 'Tecido'], ['ML_TRILHO', 'Trilho']] },
      { chave: 'fator_pe_direito_alto', rotulo: 'Fator para pé-direito acima de 3 m', tipo: 'numero', dica: 'Ex.: 1,30 = 30% a mais.' },
    ],
  },
  INSTALACAO: {
    perfil: 'INSTALACAO', unidadePadrao: 'UN', rotuloCor: 'Detalhe', exemploNome: 'Instalação Cortina até 3,00 m',
    descricao: 'Serviço de instalação.',
    campos: [
      { chave: 'tipo', rotulo: 'Para', tipo: 'opcoes', opcoes: [['CORTINA', 'Cortina'], ['PERSIANA_MANUAL', 'Persiana manual'], ['PERSIANA_MOTORIZADA', 'Persiana motorizada'], ['ADICIONAL', 'Adicional']] },
      { chave: 'larg_min_m', rotulo: 'Vale a partir da largura', tipo: 'numero', sufixo: 'm' },
      { chave: 'alt_min_m', rotulo: 'Vale a partir da altura', tipo: 'numero', sufixo: 'm' },
    ],
  },
  GENERICO: {
    perfil: 'GENERICO', unidadePadrao: 'UN', rotuloCor: 'Cor / coleção', exemploNome: '',
    descricao: '', campos: [],
  },
};

export function modeloCadastro(perfil: string | null | undefined): ModeloCadastro {
  return MODELOS_CADASTRO[(perfil ?? 'GENERICO') as PerfilCadastro] ?? MODELOS_CADASTRO.GENERICO;
}

/**
 * Lê os campos técnicos de um formulário (texto digitado) para a metadata.
 * Campo vazio sai da metadata; chaves que não são do perfil ficam como estavam (não perde dados).
 */
export function metadataDosCampos(
  perfil: string | null | undefined,
  valores: Record<string, string | boolean | undefined>,
  anterior: Record<string, unknown> = {},
): { metadata: Record<string, unknown>; erros: string[] } {
  const m = modeloCadastro(perfil);
  const metadata: Record<string, unknown> = { ...anterior };
  const erros: string[] = [];
  for (const c of m.campos) {
    const v = valores[c.chave];
    if (c.tipo === 'simnao') { metadata[c.chave] = v === true || v === 'true' || v === 'on'; continue; }
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t) {
      delete metadata[c.chave];
      if (c.obrigatorio) erros.push(`Preencha: ${c.rotulo}.`);
      continue;
    }
    if (c.tipo === 'opcoes') { metadata[c.chave] = c.chave === 'vias' ? Number(t) : t; continue; }
    const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
    if (!Number.isFinite(n) || n < 0) { erros.push(`${c.rotulo}: número inválido.`); continue; }
    if (c.tipo === 'inteiro' && !Number.isInteger(n)) { erros.push(`${c.rotulo}: use número inteiro.`); continue; }
    metadata[c.chave] = n;
  }
  return { metadata, erros };
}

/**
 * Trava de segurança para alteração em massa (Gabriel, 27/11/2026): mais de `limite` itens
 * mudando de uma vez (markup, importação de preços...) exige digitar `palavra` e clicar em Continuar.
 */
export const ALTERACAO_EM_MASSA = { limite: 10, palavra: 'ALTERAR' } as const;
