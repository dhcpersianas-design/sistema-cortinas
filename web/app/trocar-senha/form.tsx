'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/cliente';

export function FormTrocarSenha() {
  const router = useRouter();
  const [erro, setErro] = useState<string | null>(null);

  async function enviar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('novaSenha') !== f.get('confirmacao')) return setErro('As senhas não conferem.');
    setErro(null);
    try {
      await api('/api/auth/trocar-senha', { method: 'POST', corpo: { senhaAtual: f.get('senhaAtual'), novaSenha: f.get('novaSenha') } });
      router.replace('/');
      router.refresh();
    } catch (err) {
      setErro((err as Error).message);
    }
  }

  return (
    <form onSubmit={enviar} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2"><Label htmlFor="senhaAtual">Senha atual</Label><Input id="senhaAtual" name="senhaAtual" type="password" autoComplete="current-password" required /></div>
      <div className="flex flex-col gap-2"><Label htmlFor="novaSenha">Nova senha</Label><Input id="novaSenha" name="novaSenha" type="password" autoComplete="new-password" minLength={8} required /></div>
      <div className="flex flex-col gap-2"><Label htmlFor="confirmacao">Repita a nova senha</Label><Input id="confirmacao" name="confirmacao" type="password" autoComplete="new-password" required /></div>
      {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
      <Button type="submit" size="lg">Salvar</Button>
    </form>
  );
}
