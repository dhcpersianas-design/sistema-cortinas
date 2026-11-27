'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Campo, CampoTexto, CamposEndereco, classeSelect, lerFormulario, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';

export const CATEGORIAS: Record<string, string> = {
  TECIDO: 'Tecidos', PERSIANA: 'Persianas', FERRAGEM: 'Trilhos e ferragens', MOTORIZACAO: 'Motorização',
  COSTUREIRA: 'Costureira / ateliê', INSTALADOR: 'Instalador (terceirizado)', OUTRO: 'Outro',
};

export type Fornecedor = {
  id: string; nomeFantasia: string; razaoSocial: string | null; cnpj: string | null; cnpjFormatado: string;
  categoria: string; telefone: string | null; telefoneFormatado: string; whatsapp: string | null; whatsappFormatado: string;
  whatsappLink: string | null; email: string | null; contatoNome: string | null; prazoEntregaDias: number | null;
  cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null; bairro: string | null;
  cidade: string | null; uf: string | null; chavePix: string | null; observacoes: string | null; ativo: boolean | null;
};

const CAMPOS = ['nomeFantasia', 'razaoSocial', 'documento', 'categoria', 'telefone', 'whatsapp', 'email', 'contatoNome',
  'prazoEntregaDias', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'chavePix', 'observacoes'];

export function Fornecedores() {
  const [q, setQ] = useState('');
  const [categoria, setCategoria] = useState('');
  const [inativos, setInativos] = useState(false);
  const [lista, setLista] = useState<Fornecedor[] | null>(null);
  const [editando, setEditando] = useState<Fornecedor | 'novo' | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    const p = new URLSearchParams({ ...(q && { q }), ...(categoria && { categoria }), ...(inativos && { inativos: '1' }) });
    const t = setTimeout(() => {
      api<{ fornecedores: Fornecedor[] }>(`/api/fornecedores?${p}`).then((r) => setLista(r.fornecedores)).catch((e) => setErro(e.message));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, categoria, inativos, versao]);

  async function salvar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null); setOk(null);
    const dados: Record<string, unknown> = lerFormulario(e.currentTarget, CAMPOS);
    if (dados.prazoEntregaDias === '') dados.prazoEntregaDias = null;
    try {
      const alvo = editando !== 'novo' ? editando : null;
      const r = alvo
        ? await api<{ fornecedor: Fornecedor }>(`/api/fornecedores/${alvo.id}`, { method: 'PATCH', corpo: dados })
        : await api<{ fornecedor: Fornecedor }>('/api/fornecedores', { method: 'POST', corpo: dados });
      setOk(`${r.fornecedor.nomeFantasia} salvo.`);
      setEditando(null); setVersao((v) => v + 1);
    } catch (err) { setErro((err as Error).message); }
  }

  async function alternarAtivo(f: Fornecedor) {
    try {
      await api(`/api/fornecedores/${f.id}`, { method: 'PATCH', corpo: { ativo: !f.ativo } });
      setVersao((v) => v + 1);
    } catch (err) { setErro((err as Error).message); }
  }

  if (editando) {
    const v = editando === 'novo' ? null : editando;
    return (
      <Card>
        <CardHeader><CardTitle>{v ? `Editar ${v.nomeFantasia}` : 'Novo fornecedor'}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={salvar} className="grid gap-4 sm:grid-cols-2">
            <Campo rotulo="Nome *" nome="nomeFantasia" required defaultValue={v?.nomeFantasia} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="categoria">Categoria *</Label>
              <select id="categoria" name="categoria" required defaultValue={v?.categoria ?? ''} className={classeSelect}>
                <option value="" disabled>Escolha…</option>
                {Object.entries(CATEGORIAS).map(([k, r]) => <option key={k} value={k}>{r}</option>)}
              </select>
            </div>
            <Campo rotulo="Razão social" nome="razaoSocial" defaultValue={v?.razaoSocial ?? ''} />
            <Campo rotulo="CNPJ ou CPF" nome="documento" inputMode="numeric" defaultValue={v?.cnpjFormatado ?? ''} dica="Instalador pessoa física: CPF" />
            <Campo rotulo="Contato" nome="contatoNome" defaultValue={v?.contatoNome ?? ''} />
            <Campo rotulo="E-mail" nome="email" type="email" defaultValue={v?.email ?? ''} />
            <Campo rotulo="Telefone" nome="telefone" inputMode="tel" defaultValue={v?.telefoneFormatado ?? ''} />
            <Campo rotulo="WhatsApp" nome="whatsapp" inputMode="tel" defaultValue={v?.whatsappFormatado ?? ''} />
            <Campo rotulo="Prazo de entrega (dias)" nome="prazoEntregaDias" type="number" min={0} max={365} defaultValue={v?.prazoEntregaDias ?? 10} />
            <Campo rotulo="Chave PIX" nome="chavePix" defaultValue={v?.chavePix ?? ''} dica="Para pagar instalador / costureira" />
            <CamposEndereco inicial={v ?? undefined} />
            <CampoTexto rotulo="Observações" nome="observacoes" defaultValue={v?.observacoes} />
            <div className="sm:col-span-2"><Mensagens erro={erro} /></div>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit">Salvar</Button>
              <Button type="button" variant="outline" onClick={() => { setEditando(null); setErro(null); }}>Cancelar</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Fornecedores</h1>
        <Button onClick={() => { setEditando('novo'); setOk(null); }}>Novo fornecedor</Button>
      </div>
      <p className="text-sm text-muted-foreground">Instaladores e costureiras terceirizados entram aqui. Eles não acessam o sistema: recebem a OS e a ficha de corte em PDF.</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_14rem_auto]">
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, CNPJ, telefone ou cidade" aria-label="Buscar fornecedores" />
        <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className={classeSelect} aria-label="Categoria">
          <option value="">Todas as categorias</option>
          {Object.entries(CATEGORIAS).map(([k, r]) => <option key={k} value={k}>{r}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={inativos} onChange={(e) => setInativos(e.target.checked)} /> inativos</label>
      </div>
      <Mensagens erro={erro} ok={ok} />
      {lista === null ? <p className="text-sm text-muted-foreground">Carregando…</p> : lista.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum fornecedor encontrado.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {lista.map((f) => (
            <Card key={f.id} className={f.ativo ? '' : 'opacity-60'}>
              <CardContent className="flex flex-wrap items-center gap-3 py-3 pt-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{f.nomeFantasia} {!f.ativo && <span className="text-sm text-muted-foreground">(inativo)</span>}</div>
                  <div className="truncate text-sm text-muted-foreground">
                    {[f.contatoNome, f.whatsappFormatado || f.telefoneFormatado, f.cidade, f.prazoEntregaDias != null && `${f.prazoEntregaDias} dias`].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <Badge>{CATEGORIAS[f.categoria] ?? f.categoria}</Badge>
                {f.whatsappLink && <Button asChild variant="outline" size="sm"><a href={f.whatsappLink} target="_blank" rel="noopener noreferrer">WhatsApp</a></Button>}
                <Button variant="outline" size="sm" onClick={() => { setEditando(f); setOk(null); }}>Editar</Button>
                <Button variant="ghost" size="sm" onClick={() => alternarAtivo(f)}>{f.ativo ? 'Inativar' : 'Reativar'}</Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
