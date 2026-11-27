import { Suspense } from 'react';
import { exigirUsuario } from '@/lib/sessao';
import { Instalacoes } from './instalacoes';

// A tela trabalha no navegador (agenda e aceite), para funcionar sem internet na obra.
export default async function PaginaInstalacoes() {
  const u = await exigirUsuario('pedidos.proprios');
  return (
    <Suspense>
      <Instalacoes admin={u.permissoes.includes('instalacao.gerenciar')} />
    </Suspense>
  );
}
