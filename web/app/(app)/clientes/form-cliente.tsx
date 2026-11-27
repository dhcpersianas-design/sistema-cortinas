'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Campo, CampoTexto, CamposEndereco, classeSelect, lerFormulario, Mensagens } from '@/components/cadastro/campos';
import { abrirFicha, criarCliente, editarCliente, type Cliente } from '@/lib/clientes-offline';
import { api } from '@/lib/cliente';

const CAMPOS = [
  'nomeCompleto', 'telefoneWhatsapp', 'telefoneSecundario', 'email', 'documento', 'origemLead',
  'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'tipoImovel', 'obsAcessoInstalacao', 'observacoes',
];
const ORIGENS = ['Indicação', 'Instagram', 'Google', 'Loja física', 'Arquiteto/Decorador', 'WhatsApp', 'Outro'];
const IMOVEIS = ['Apartamento', 'Casa', 'Condomínio fechado', 'Comercial', 'Outro'];

type Props = { clienteId: string | null; admin: boolean; onSalvo: (c: Cliente) => void; onCancelar: () => void };

export function FormCliente({ clienteId, admin, onSalvo, onCancelar }: Props) {
  const [atual, setAtual] = useState<Cliente | null>(null);
  const [carregando, setCarregando] = useState(Boolean(clienteId));
  const [vendedores, setVendedores] = useState<{ id: string; nome: string }[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!clienteId) return;
    abrirFicha(clienteId).then((f) => { setAtual(f?.cliente ?? null); setCarregando(false); });
  }, [clienteId]);
  useEffect(() => {
    if (admin) api<{ vendedores: { id: string; nome: string }[] }>('/api/clientes-vendedores').then((r) => setVendedores(r.vendedores)).catch(() => {});
  }, [admin]);

  async function salvar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErro(null); setSalvando(true);
    const dados: Record<string, string | null> = lerFormulario(e.currentTarget, CAMPOS);
    const vend = new FormData(e.currentTarget).get('vendedorResponsavelId');
    if (admin && vend) dados.vendedorResponsavelId = String(vend);
    try {
      const r = atual ? await editarCliente(atual, dados) : await criarCliente(dados);
      onSalvo(r.cliente);
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (clienteId && !atual) return <Mensagens erro="Cliente não encontrado." />;
  const v = atual;

  return (
    <Card>
      <CardHeader><CardTitle>{v ? `Editar ${v.nomeCompleto}` : 'Novo cliente'}</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={salvar} className="grid gap-4 sm:grid-cols-2">
          <Campo rotulo="Nome completo *" nome="nomeCompleto" required minLength={2} defaultValue={v?.nomeCompleto} largo autoComplete="name" />
          <Campo rotulo="WhatsApp *" nome="telefoneWhatsapp" required inputMode="tel" autoComplete="tel"
            defaultValue={v?.telefoneFormatado || v?.telefoneWhatsapp} placeholder="(11) 98765-4321" />
          <Campo rotulo="Outro telefone" nome="telefoneSecundario" inputMode="tel" defaultValue={v?.telefoneSecundario ?? ''} />
          <Campo rotulo="E-mail" nome="email" type="email" autoComplete="email" defaultValue={v?.email ?? ''} />
          <Campo rotulo="CPF ou CNPJ" nome="documento" inputMode="numeric" defaultValue={v?.cpfCnpjFormatado ?? ''} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="origemLead">Como conheceu a loja</Label>
            <select id="origemLead" name="origemLead" defaultValue={v?.origemLead ?? ''} className={classeSelect}>
              <option value="">—</option>
              {[...new Set([...ORIGENS, ...(v?.origemLead ? [v.origemLead] : [])])].map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tipoImovel">Tipo de imóvel</Label>
            <select id="tipoImovel" name="tipoImovel" defaultValue={v?.tipoImovel ?? ''} className={classeSelect}>
              <option value="">—</option>
              {[...new Set([...IMOVEIS, ...(v?.tipoImovel ? [v.tipoImovel] : [])])].map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <CamposEndereco inicial={v ?? undefined} />
          <CampoTexto rotulo="Acesso para instalação (portaria, horários, elevador)" nome="obsAcessoInstalacao" defaultValue={v?.obsAcessoInstalacao} />
          <CampoTexto rotulo="Observações" nome="observacoes" defaultValue={v?.observacoes} />
          {admin && vendedores.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vendedorResponsavelId">Vendedor responsável</Label>
              <select id="vendedorResponsavelId" name="vendedorResponsavelId" defaultValue={v?.vendedorResponsavelId ?? ''} className={classeSelect}>
                {!v && <option value="">Eu mesmo</option>}
                {vendedores.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}
              </select>
            </div>
          )}
          <div className="sm:col-span-2"><Mensagens erro={erro} /></div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</Button>
            <Button type="button" variant="outline" onClick={onCancelar}>Cancelar</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
