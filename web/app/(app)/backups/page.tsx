import { apiServidor, exigirUsuario } from '@/lib/sessao';
import { Backups, type InfoBackups } from './backups';

export default async function PaginaBackups() {
  await exigirUsuario('backups.gerenciar');
  const { dados } = await apiServidor<InfoBackups>('/api/admin/backups');
  return <Backups inicial={dados ?? { ativo: false, manter: 14, backups: [] }} />;
}
