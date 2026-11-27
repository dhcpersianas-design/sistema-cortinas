import { describe, expect, it } from 'vitest';
import { PERMISSOES, permissoesDe } from '../src/auth/permissoes.js';

describe('matriz de permissões (2 perfis)', () => {
  it('ADMIN tem tudo', () => {
    expect(permissoesDe({ perfil: 'ADMIN', podeVerCustos: false }).size).toBe(PERMISSOES.length);
  });

  it('VENDEDOR: só o trabalho de campo, sem custos por padrão', () => {
    expect([...permissoesDe({ perfil: 'VENDEDOR', podeVerCustos: false })].sort()).toEqual([
      'calculo.usar', 'catalogo.ver', 'clientes.editar', 'clientes.ver',
      'medicoes.proprias', 'orcamentos.proprios', 'pedidos.proprios',
    ]);
  });

  it('VENDEDOR com pode_ver_custos ganha só custos.ver', () => {
    const com = permissoesDe({ perfil: 'VENDEDOR', podeVerCustos: true });
    const sem = permissoesDe({ perfil: 'VENDEDOR', podeVerCustos: false });
    expect([...com].filter((p) => !sem.has(p))).toEqual(['custos.ver']);
  });
});
