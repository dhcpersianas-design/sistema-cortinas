import { Suspense } from 'react';
import { exigirUsuario } from '@/lib/sessao';
import { Agenda } from './agenda';

// A tela trabalha no navegador (agenda, vãos e fotos), para funcionar sem internet na obra.
export default async function PaginaAgenda() {
  const u = await exigirUsuario('medicoes.proprias');
  return (
    <Suspense>
      <Agenda admin={u.permissoes.includes('medicoes.todas')} />
    </Suspense>
  );
}
