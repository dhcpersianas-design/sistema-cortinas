'use client';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/cliente';

export function BotaoSair() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        router.replace('/login');
        router.refresh();
      }}
    >
      Sair
    </Button>
  );
}
