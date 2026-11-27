import type { Perfil } from '../db/schema.js';

/**
 * Permissões do sistema. Só existem 2 perfis (decisão do Gabriel, 27/11/2026):
 *  - ADMIN: acesso total (inclui o que a especificação dava a FINANCEIRO e INSTALADOR).
 *  - VENDEDOR: vendedor em campo. Clientes (só os dele), orçamentos e pedidos próprios, medição
 *    no local e cálculo. Custo de fábrica só com a flag `pode_ver_custos`.
 * Matriz completa e motivos em docs/decisoes.md.
 */
export const PERMISSOES = [
  'clientes.ver', 'clientes.editar', 'clientes.todos',
  'orcamentos.proprios', 'orcamentos.todos',
  'medicoes.proprias', 'medicoes.todas',
  'pedidos.proprios', 'pedidos.todos',
  'calculo.usar',
  'catalogo.ver', 'catalogo.editar', 'precos.editar',
  'custos.ver',
  'margem.liberar_vermelho',
  'fornecedores.ver', 'fornecedores.editar',
  'compras.gerenciar', 'producao.gerenciar', 'instalacao.gerenciar',
  'financeiro.gerenciar', 'relatorios.ver',
  'usuarios.gerenciar', 'parametros.editar', 'backups.gerenciar',
] as const;
export type Permissao = (typeof PERMISSOES)[number];

const VENDEDOR_BASE: readonly Permissao[] = [
  'clientes.ver', 'clientes.editar',
  'orcamentos.proprios', 'medicoes.proprias', 'pedidos.proprios',
  'calculo.usar', 'catalogo.ver',
];

export interface SujeitoPermissao {
  perfil: Perfil;
  podeVerCustos: boolean | null;
}

export function permissoesDe(u: SujeitoPermissao): Set<Permissao> {
  if (u.perfil === 'ADMIN') return new Set(PERMISSOES);
  const p = new Set<Permissao>(VENDEDOR_BASE);
  if (u.podeVerCustos) p.add('custos.ver');
  return p;
}

export function pode(u: SujeitoPermissao, permissao: Permissao): boolean {
  return permissoesDe(u).has(permissao);
}
