import { exigirUsuario } from '@/lib/sessao';
import { EditorProduto } from './editor';

export default async function PaginaProduto({ params }: { params: Promise<{ id: string }> }) {
  await exigirUsuario('catalogo.editar');
  const { id } = await params;
  return <EditorProduto id={id === 'novo' ? null : id} />;
}
