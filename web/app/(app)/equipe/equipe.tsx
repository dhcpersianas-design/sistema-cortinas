'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/cliente';

export type Membro = {
  id: string; nome: string; email: string; perfil: 'ADMIN' | 'VENDEDOR'; podeVerCustos: boolean | null;
  descontoMaxPct: string | null; ativo: boolean | null; ultimoLoginEm: string | null;
};

export function Equipe({ inicial, meuId }: { inicial: Membro[]; meuId: string }) {
  const [membros, setMembros] = useState(inicial);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function criar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setErro(null); setOk(null);
    try {
      const { usuario } = await api<{ usuario: Membro }>('/api/usuarios', {
        method: 'POST',
        corpo: {
          nome: f.get('nome'), email: f.get('email'), senhaInicial: f.get('senhaInicial'),
          perfil: f.get('perfil'), podeVerCustos: f.get('podeVerCustos') === 'on',
          descontoMaxPct: String(f.get('descontoMaxPct') || '10'),
        },
      });
      setMembros((m) => [...m, usuario].sort((a, b) => a.nome.localeCompare(b.nome)));
      setOk(`${usuario.nome} criado. Passe a senha inicial; o sistema pede a troca no primeiro acesso.`);
      form.reset();
    } catch (err) {
      setErro((err as Error).message);
    }
  }

  async function alterar(id: string, corpo: Partial<Membro>) {
    setErro(null); setOk(null);
    try {
      const { usuario } = await api<{ usuario: Membro }>(`/api/usuarios/${id}`, { method: 'PATCH', corpo });
      setMembros((m) => m.map((x) => (x.id === id ? usuario : x)));
    } catch (err) {
      setErro((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Equipe</h1>
      {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
      {ok && <p className="text-sm text-primary">{ok}</p>}

      <div className="flex flex-col gap-2">
        {membros.map((m) => (
          <Card key={m.id} className={m.ativo ? '' : 'opacity-60'}>
            <CardContent className="flex flex-wrap items-center gap-3 pt-5">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{m.nome} {!m.ativo && <span className="text-sm text-muted-foreground">(inativo)</span>}</div>
                <div className="truncate text-sm text-muted-foreground">{m.email}</div>
              </div>
              <Badge>{m.perfil === 'ADMIN' ? 'Administrador' : 'Vendedor'}</Badge>
              {m.perfil === 'VENDEDOR' && (
                <>
                  <Badge className="text-muted-foreground">desconto até {m.descontoMaxPct}%</Badge>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={Boolean(m.podeVerCustos)} onChange={(e) => alterar(m.id, { podeVerCustos: e.target.checked })} />
                    vê custos
                  </label>
                </>
              )}
              {m.id !== meuId && (
                <Button variant="outline" size="sm" onClick={() => alterar(m.id, { ativo: !m.ativo })}>
                  {m.ativo ? 'Desativar' : 'Reativar'}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle>Novo usuário</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={criar} className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2"><Label htmlFor="nome">Nome</Label><Input id="nome" name="nome" required /></div>
            <div className="flex flex-col gap-2"><Label htmlFor="email">E-mail</Label><Input id="email" name="email" type="email" required /></div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="senhaInicial">Senha inicial</Label>
              <Input id="senhaInicial" name="senhaInicial" type="text" minLength={8} required placeholder="8+ caracteres, letras e números" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="perfil">Perfil</Label>
              <select id="perfil" name="perfil" defaultValue="VENDEDOR" className="h-11 rounded-md border border-input bg-card px-3 sm:h-10 sm:text-sm">
                <option value="VENDEDOR">Vendedor em campo</option>
                <option value="ADMIN">Administrador (acesso total)</option>
              </select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="descontoMaxPct">Desconto máximo (%)</Label>
              <Input id="descontoMaxPct" name="descontoMaxPct" inputMode="decimal" defaultValue="10" />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" name="podeVerCustos" /> Pode ver custos de fábrica
            </label>
            <div className="sm:col-span-2"><Button type="submit">Criar usuário</Button></div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
