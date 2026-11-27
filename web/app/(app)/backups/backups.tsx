'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/cliente';

type Backup = { arquivo: string; bytes: number; criadoEm: string };
export type InfoBackups = { ativo: boolean; manter: number; backups: Backup[] };

function tamanho(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Backups({ inicial }: { inicial: InfoBackups }) {
  const [info, setInfo] = useState(inicial);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function fazerAgora() {
    setErro(null); setCarregando(true);
    try {
      await api('/api/admin/backups', { method: 'POST' });
      setInfo(await api<InfoBackups>('/api/admin/backups'));
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Backups do banco</h1>
      <Card>
        <CardHeader><CardTitle>Como funciona</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {info.ativo ? (
            <>
              <p>O sistema faz uma cópia de todos os dados todo dia de madrugada e guarda as últimas {info.manter}.</p>
              <p>Essas cópias ficam no próprio servidor. <strong>Uma vez por semana, baixe a mais recente</strong> e
                guarde no seu computador ou no Google Drive: assim, se o servidor tiver problema, os dados estão salvos fora dele.</p>
            </>
          ) : (
            <p>O backup automático não está ligado neste servidor.</p>
          )}
        </CardContent>
      </Card>
      {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
      {info.ativo && (
        <div><Button onClick={fazerAgora} disabled={carregando}>{carregando ? 'Gerando...' : 'Fazer backup agora'}</Button></div>
      )}
      <div className="flex flex-col gap-2">
        {info.ativo && info.backups.length === 0 && <p className="text-sm text-muted-foreground">Nenhum backup ainda.</p>}
        {info.backups.map((b) => (
          <Card key={b.arquivo}>
            <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className="text-sm">
                <div className="font-medium">{new Date(b.criadoEm).toLocaleString('pt-BR')}</div>
                <div className="text-muted-foreground">{b.arquivo} · {tamanho(b.bytes)}</div>
              </div>
              <a href={`/api/admin/backups/${b.arquivo}`} download className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Baixar</a>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
