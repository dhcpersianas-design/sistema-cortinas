import { Suspense } from 'react';
import { exigirUsuario } from '@/lib/sessao';
import { Clientes } from './clientes';

// A tela trabalha no navegador (busca, cadastro e ficha), para funcionar offline na obra.
export default async function PaginaClientes() {
  const u = await exigirUsuario('clientes.ver');
  return (
    <Suspense>
      <Clientes admin={u.permissoes.includes('clientes.todos')} />
    </Suspense>
  );
}
