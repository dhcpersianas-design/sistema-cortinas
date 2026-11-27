'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Mensagens } from '@/components/cadastro/campos';
import { abrirFicha, editarCliente, type Ficha } from '@/lib/clientes-offline';
import { dinheiro } from '@/lib/utils';
import { formatarData } from '@/lib/texto';

const PAGAMENTO: Record<string, string> = {
  PIX: 'PIX', CREDITO_AVISTA: 'Crédito à vista', CREDITO_PARCELADO: 'Crédito parcelado', DEBITO: 'Débito',
  BOLETO: 'Boleto', DINHEIRO: 'Dinheiro', MISTO: 'Misto',
};
const rotulo = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

type Props = { id: string; admin: boolean; onVoltar: () => void; onEditar: () => void; onAlterado: () => void };

export function FichaCliente({ id, admin, onVoltar, onEditar, onAlterado }: Props) {
  const [ficha, setFicha] = useState<Ficha | null | undefined>(undefined);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => { abrirFicha(id).then(setFicha).catch((e) => setErro((e as Error).message)); }, [id]);

  if (erro) return <Mensagens erro={erro} />;
  if (ficha === undefined) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (ficha === null) return (<div className="flex flex-col gap-3"><Mensagens erro="Cliente não encontrado." /><Button variant="outline" onClick={onVoltar} className="self-start">Voltar</Button></div>);

  const c = ficha.cliente;
  const primeiroNome = c.nomeCompleto.split(' ')[0];
  const whats = c.whatsappLink ? `${c.whatsappLink}?text=${encodeURIComponent(`Olá, ${primeiroNome}! Aqui é da loja de cortinas e persianas.`)}` : null;
  const endereco = [[c.logradouro, c.numero].filter(Boolean).join(', '), c.complemento, c.bairro, [c.cidade, c.uf].filter(Boolean).join('/'), c.cep]
    .filter(Boolean).join(' · ');
  const h = ficha.historico;

  async function alternarAtivo() {
    try {
      const r = await editarCliente(c, { ativo: c.ativo === false });
      setFicha({ ...ficha!, cliente: r.cliente }); onAlterado();
    } catch (e) { setErro((e as Error).message); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onVoltar}>← Clientes</Button>
        <h1 className="flex-1 text-xl font-semibold">{c.nomeCompleto}</h1>
        {c.pendente && <Badge className="border-amber-500/50">não enviado</Badge>}
        {c.ativo === false && <Badge className="text-muted-foreground">inativo</Badge>}
      </div>

      <div className="flex flex-wrap gap-2">
        {whats && <Button asChild><a href={whats} target="_blank" rel="noopener noreferrer">Abrir WhatsApp</a></Button>}
        {c.telefoneWhatsapp && <Button asChild variant="outline"><a href={`tel:${c.telefoneWhatsapp}`}>Ligar</a></Button>}
        <Button variant="outline" onClick={onEditar}>Editar</Button>
        {admin && !c.pendente && <Button variant="outline" onClick={alternarAtivo}>{c.ativo === false ? 'Reativar' : 'Inativar'}</Button>}
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-5 text-sm sm:grid-cols-2">
          <Info r="WhatsApp" v={c.telefoneFormatado || c.telefoneWhatsapp} />
          <Info r="Outro telefone" v={c.telefoneSecundario} />
          <Info r="E-mail" v={c.email} />
          <Info r={c.tipoPessoa === 'PJ' ? 'CNPJ' : 'CPF'} v={c.cpfCnpjFormatado} />
          <Info r="Endereço" v={endereco} largo />
          <Info r="Tipo de imóvel" v={c.tipoImovel} />
          <Info r="Como conheceu" v={c.origemLead} />
          <Info r="Acesso para instalação" v={c.obsAcessoInstalacao} largo />
          <Info r="Observações" v={c.observacoes} largo />
          <Info r="Cliente desde" v={formatarData(c.dataRegistro)} />
          {admin && <Info r="Vendedor responsável" v={c.vendedorResponsavelNome} />}
        </CardContent>
      </Card>

      {h === null ? (
        <p className="text-sm text-muted-foreground">Histórico de compras disponível com internet.</p>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>Compras ({h.pedidos.length})</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {h.pedidos.length === 0 && <p className="text-muted-foreground">Nenhuma compra ainda.</p>}
              {h.pedidos.map((p) => (
                <div key={p.pedidoId} className="rounded-md border p-3">
                  <div className="flex flex-wrap justify-between gap-2 font-medium">
                    <span>Pedido {p.numeroPedido} · {formatarData(p.dataCompra)}</span>
                    <span className="tabular-nums">{dinheiro(p.valorTotal)}</span>
                  </div>
                  <div className="text-muted-foreground">
                    {[p.formaPagamento && PAGAMENTO[p.formaPagamento], rotulo(p.status), p.dataInstalacao && `instalado em ${formatarData(p.dataInstalacao)}`].filter(Boolean).join(' · ')}
                  </div>
                  {p.produtos && <div className="mt-1">{p.produtos}</div>}
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Instalações ({h.instalacoes.length})</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {h.instalacoes.length === 0 && <p className="text-muted-foreground">Nenhuma instalação ainda.</p>}
              {h.instalacoes.map((i) => <div key={i.pedidoId}>{formatarData(i.dataInstalacao)} · Pedido {i.numeroPedido}{i.produtos ? ` · ${i.produtos}` : ''}</div>)}
            </CardContent>
          </Card>
          {h.orcamentos.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Orçamentos ({h.orcamentos.length})</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {h.orcamentos.map((o) => (
                  <div key={o.id} className="flex flex-wrap justify-between gap-2">
                    <span>{o.codigo} v{o.versao} · {formatarData(o.dataCriacao)} · {rotulo(o.status)}</span>
                    <span className="tabular-nums">{dinheiro(o.valorTotal)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Info({ r, v, largo }: { r: string; v: string | null | undefined; largo?: boolean }) {
  if (!v) return null;
  return (
    <div className={largo ? 'sm:col-span-2' : ''}>
      <div className="text-xs text-muted-foreground">{r}</div>
      <div className="whitespace-pre-line">{v}</div>
    </div>
  );
}
