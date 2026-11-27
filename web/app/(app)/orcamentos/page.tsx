import { Suspense } from 'react';
import { exigirUsuario } from '@/lib/sessao';
import { Orcamentos } from './orcamentos';

// A tela trabalha no navegador (lista, configurador e cálculo), para funcionar offline na obra.
export default async function PaginaOrcamentos() {
  const u = await exigirUsuario('orcamentos.proprios');
  return (
    <Suspense>
      <Orcamentos admin={u.perfil === 'ADMIN'} verCusto={u.permissoes.includes('custos.ver')} />
    </Suspense>
  );
}
