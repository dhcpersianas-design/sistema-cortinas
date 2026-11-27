'use client';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { classeSelect, classeTextarea, Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';
import { FORMAS, metros, moeda } from '../orcamentos/formato';
import { CartaoOrdem, type Ordem } from './ordens';
import { corStatus, dataBR, dataHoraBR, ETAPAS, hojeISO, isoParaLocal, localParaIso, STATUS_PEDIDO } from './formato';

type Resumo = {
  id: string; numero: string; titulo: string | null; status: string; clienteNome: string; vendedorNome: string;
  valorTotal: string; dataCompra: string; previsaoEntrega: string | null; instalacaoAgendada: string | null;
  aditivoAberto: boolean; semNota: boolean; atrasado: boolean;
};
type Aditivo = {
  id: string; numero: number; tipo: 'CONFERENCIA_MEDIDAS' | 'ALTERACAO'; status: string; motivo: string | null; orcamentoId?: string | null;
  orcamentoNovoId: string | null; valorAnterior: string; valorNovo: string | null; diferenca: string | null; criadoEm: string; criadoPor: string | null;
};
type Pedido = {
  id: string; numero: string; status: string; statusNome: string; titulo: string | null;
  orcamentoId: string; orcamentoCodigo: string; orcamentoVersao: number;
  clienteId: string; clienteNome: string; clienteTelefone: string; clienteEndereco: string | null; clienteObsAcesso: string | null;
  vendedorNome: string; dataCompra: string; previsaoEntrega: string | null;
  instalacaoAgendada: string | null; duracaoHoras: string | null; instalacaoRealizada: string | null;
  instaladorId: string | null; instaladorNome: string | null; obsInstalacao: string | null;
  formaPagamento: string | null; valorTotal: string; valorOriginal: string | null; saldo: string;
  custoPrevisto?: string; custoReal?: string | null;
  sinalValor: string | null; sinalForma: string | null; sinalRecebidoEm: string | null; liberadoSemSinal: boolean;
  medidasConferidasEm: string | null; motivoCancelamento: string | null;
  nfeNumero: string | null; nfeChave: string | null; nfseNumero: string | null;
  itens: { id: string; ambiente: string; tipo: string; descricaoComercial: string; larguraProducao: string; alturaProducao: string; vendaTotal: string; alertas: { severidade: string; mensagem: string }[] }[];
  aditivos: Aditivo[]; aditivoAberto: Aditivo | null; compras: Ordem[];
  aceite: { nomeRecebedor: string; assinadoEm: string; ressalvas: boolean; observacoes: string | null; offline: boolean } | null;
  eventos: { id: string; acao: string; descricao: string; offline: boolean; criadoEm: string; usuario: string | null }[];
  acoes: string[];
};

function irPara(id: string | null) {
  window.history.pushState(null, '', id ? `/pedidos?p=${id}` : '/pedidos');
}

export function Pedidos({ admin }: { admin: boolean }) {
  const sp = useSearchParams();
  const aberto = sp.get('p');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('ABERTOS');
  const [lista, setLista] = useState<Resumo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (aberto) return;
    let vivo = true;
    const t = setTimeout(async () => {
      try {
        const p = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) });
        const r = await api<{ pedidos: Resumo[] }>(`/api/pedidos?${p}`);
        if (vivo) { setLista(r.pedidos); setErro(null); }
      } catch (e) { if (vivo) setErro(e instanceof TypeError ? 'Sem internet: a lista de pedidos precisa de conexão.' : (e as Error).message); }
    }, q ? 250 : 0);
    return () => { vivo = false; clearTimeout(t); };
  }, [q, status, aberto]);

  if (aberto) return <DetalhePedido id={aberto} admin={admin} onVoltar={() => irPara(null)} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">Pedidos</h1>
      </div>
      <p className="text-sm text-muted-foreground">Pedido nasce quando o cliente aprova o orçamento (botão &quot;Cliente aprovou&quot; no orçamento enviado).</p>
      <div className="flex flex-wrap gap-2">
        <Input className="w-64" placeholder="Buscar cliente, número ou projeto" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${classeSelect} w-56`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ABERTOS">Em andamento</option>
          <option value="">Todos</option>
          {Object.entries(STATUS_PEDIDO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <Mensagens erro={erro} />
      {lista && lista.length === 0 && <p className="text-sm text-muted-foreground">Nenhum pedido.</p>}
      <div className="space-y-2">
        {lista?.map((p) => (
          <button key={p.id} type="button" onClick={() => irPara(p.id)} className="block w-full rounded-md border bg-card p-3 text-left hover:bg-muted">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.numero}</span>
              <Badge className={corStatus(p.status)}>{STATUS_PEDIDO[p.status] ?? p.status}</Badge>
              {p.aditivoAberto && <Badge className="border-amber-500/50 text-amber-700 dark:text-amber-400">Aditivo em aberto</Badge>}
              {p.atrasado && <Badge className="border-red-500/50 text-red-700 dark:text-red-400">Atrasado</Badge>}
              {p.semNota && admin && <Badge className="border-red-500/50 text-red-700 dark:text-red-400">Sem nota fiscal</Badge>}
              <span className="ml-auto font-medium">{moeda(p.valorTotal)}</span>
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              {p.clienteNome}{p.titulo ? ` · ${p.titulo}` : ''}{admin ? ` · ${p.vendedorNome}` : ''}
              {p.instalacaoAgendada ? ` · instalação ${dataHoraBR(p.instalacaoAgendada)}` : p.previsaoEntrega ? ` · entrega ${dataBR(p.previsaoEntrega)}` : ''}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ detalhe

function DetalhePedido({ id, admin, onVoltar }: { id: string; admin: boolean; onVoltar: () => void }) {
  const [p, setP] = useState<Pedido | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const [painel, setPainel] = useState<string | null>(null);
  const [instaladores, setInstaladores] = useState<{ id: string; nomeFantasia: string }[]>([]);

  const carregar = useCallback(async () => {
    try { setP((await api<{ pedido: Pedido }>(`/api/pedidos/${id}`)).pedido); }
    catch (e) { setErro(e instanceof TypeError ? 'Sem internet: o pedido precisa de conexão. Para o aceite na obra, use Instalações.' : (e as Error).message); }
  }, [id]);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    if (painel === 'AGENDAR' && instaladores.length === 0) {
      api<{ fornecedores: { id: string; nomeFantasia: string }[] }>('/api/fornecedores?categoria=INSTALADOR')
        .then((r) => setInstaladores(r.fornecedores)).catch(() => null);
    }
  }, [painel, instaladores.length]);

  async function acao(caminho: string, corpo: unknown, mensagem: string) {
    setErro(null); setOk(null); setAvisos([]); setOcupado(true);
    try {
      const r = await api<{ pedido: Pedido; resultado?: { avisos: string[] }; avisos?: string[]; orcamentoId?: string }>(caminho, { method: 'POST', corpo });
      setP(r.pedido);
      setOk(mensagem);
      setAvisos([...(r.resultado?.avisos ?? []), ...(r.avisos ?? [])]);
      setPainel(null);
      return r;
    } catch (e) { setErro((e as Error).message); return null; }
    finally { setOcupado(false); }
  }

  async function abrirAditivo(motivo: string) {
    const r = await acao(`/api/pedidos/${id}/aditivo`, { motivo: motivo || null }, 'Aditivo aberto.');
    if (r?.orcamentoId) window.location.href = `/orcamentos?o=${r.orcamentoId}`;
  }

  async function linkOs() {
    try {
      const r = await api<{ whatsapp: string }>(`/api/pedidos/${id}/link-documento`, { method: 'POST', corpo: { tipo: 'OS_INSTALACAO', origem: window.location.origin } });
      window.open(r.whatsapp, '_blank', 'noopener');
    } catch (e) { setErro((e as Error).message); }
  }

  if (!p) return <div className="space-y-3"><Button variant="ghost" size="sm" onClick={onVoltar}>← Pedidos</Button>{erro ? <Mensagens erro={erro} /> : <p className="text-sm text-muted-foreground">Carregando…</p>}</div>;

  const tem = (a: string) => p.acoes.includes(a);
  const idxEtapa = ETAPAS.indexOf(p.status);
  const grupos = new Map<string, Pedido['itens']>();
  for (const i of p.itens) grupos.set(i.ambiente, [...(grupos.get(i.ambiente) ?? []), i]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onVoltar}>← Pedidos</Button>
        <h1 className="text-xl font-semibold">{p.numero}</h1>
        <Badge className={corStatus(p.status)}>{p.statusNome}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {p.clienteNome}{p.titulo ? ` · ${p.titulo}` : ''} · vendedor {p.vendedorNome} · vendido em {dataBR(p.dataCompra)} ·{' '}
        <a className="underline" href={`/orcamentos?o=${p.orcamentoId}`}>orçamento {p.orcamentoCodigo} v{p.orcamentoVersao}</a>
      </p>

      {p.status !== 'CANCELADO' && (
        <ol className="flex flex-wrap gap-1 text-xs">
          {ETAPAS.map((e, i) => (
            <li key={e} className={`rounded px-2 py-1 ${i < idxEtapa ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : i === idxEtapa ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
              {STATUS_PEDIDO[e]}
            </li>
          ))}
        </ol>
      )}

      <Mensagens erro={erro} ok={ok} avisos={avisos} />

      {/* Próximo passo */}
      <Card>
        <CardHeader><CardTitle>Próximo passo</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {p.status === 'CANCELADO' && <p>Pedido cancelado. Motivo: {p.motivoCancelamento}</p>}
          {p.status === 'INSTALADO_CONCLUIDO' && <p>Instalado em {dataHoraBR(p.instalacaoRealizada)}. {Number(p.saldo) > 0 ? `Saldo a receber: ${moeda(p.saldo)}.` : 'Pedido concluído.'}</p>}

          {p.aditivoAberto && (
            <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
              <p>
                <strong>Aditivo {p.aditivoAberto.numero}</strong> ({p.aditivoAberto.tipo === 'CONFERENCIA_MEDIDAS' ? 'medição no local' : 'alteração pedida pelo cliente'}) em aberto
                {p.aditivoAberto.motivo ? `: ${p.aditivoAberto.motivo}` : ''}.
                Ajuste as medidas e os itens no configurador e depois confirme aqui.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline"><a href={`/orcamentos?o=${p.aditivoAberto.orcamentoId}`}>Editar o aditivo</a></Button>
                <Button disabled={ocupado} onClick={() => acao(`/api/pedidos/${id}/aditivo/confirmar`, {}, 'Aditivo confirmado.')}>Confirmar aditivo</Button>
                <Button variant="ghost" className="text-destructive" disabled={ocupado} onClick={() => acao(`/api/pedidos/${id}/aditivo/descartar`, {}, 'Aditivo descartado.')}>Descartar</Button>
              </div>
            </div>
          )}

          {p.status === 'CONFERENCIA_MEDIDAS' && !p.aditivoAberto && (
            <div className="space-y-2">
              <p>A venda foi fechada antes da medição. Meça no local: se nada mudar, confirme; se mudar, abra o aditivo de medição (o valor é recalculado e a diferença fica registrada).</p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={ocupado} onClick={() => acao(`/api/pedidos/${id}/conferir-medidas`, {}, 'Medidas conferidas.')}>Medidas conferidas, sem mudança</Button>
                <Button variant="outline" disabled={ocupado} onClick={() => abrirAditivo('Medição no local')}>Mudou algo: abrir aditivo de medição</Button>
              </div>
            </div>
          )}

          {p.status === 'AGUARDANDO_SINAL' && !p.aditivoAberto && (
            tem('REGISTRAR_SINAL') ? <FormSinal p={p} ocupado={ocupado} onSinal={(c) => acao(`/api/pedidos/${id}/liberar-compras`, c, 'Compras liberadas: as ordens por fornecedor foram geradas.')} />
              : <p>Aguardando o administrador confirmar o sinal para liberar as compras.</p>
          )}

          {['EM_COMPRA', 'EM_PRODUCAO'].includes(p.status) && (
            <p>{p.status === 'EM_COMPRA' ? 'Compras liberadas: envie as ordens aos fornecedores.' : 'Tudo encomendado: aguardando chegar e ficar pronto.'}
              {p.instalacaoAgendada ? ` Instalação pré-agendada para ${dataHoraBR(p.instalacaoAgendada)}.` : ''}</p>
          )}
          {p.status === 'PRONTO_ESTOQUE' && <p>Tudo pronto. Agende a instalação.</p>}
          {p.status === 'INSTALACAO_AGENDADA' && (
            <p>Instalação em <strong>{dataHoraBR(p.instalacaoAgendada)}</strong> com {p.instaladorNome}{p.duracaoHoras ? ` (cerca de ${p.duracaoHoras} h)` : ''}.</p>
          )}

          <div className="flex flex-wrap gap-2">
            {tem('ACEITE') && ['PRONTO_ESTOQUE', 'INSTALACAO_AGENDADA'].includes(p.status) && <Button asChild><a href={`/instalacoes?p=${id}`}>Aceite do cliente na obra</a></Button>}
            {tem('AGENDAR') && <Button variant="outline" onClick={() => setPainel(painel === 'AGENDAR' ? null : 'AGENDAR')}>{p.instalacaoAgendada ? 'Reagendar instalação' : 'Agendar instalação'}</Button>}
            {tem('DESMARCAR') && <Button variant="ghost" disabled={ocupado} onClick={() => acao(`/api/pedidos/${id}/desmarcar`, {}, 'Instalação desmarcada.')}>Desmarcar</Button>}
            {tem('ABRIR_ADITIVO') && p.status !== 'CONFERENCIA_MEDIDAS' && <Button variant="outline" onClick={() => setPainel(painel === 'ADITIVO' ? null : 'ADITIVO')}>Cliente pediu mudança (aditivo)</Button>}
            {tem('CANCELAR') && <Button variant="ghost" className="text-destructive" onClick={() => setPainel(painel === 'CANCELAR' ? null : 'CANCELAR')}>Cancelar pedido</Button>}
          </div>

          {painel === 'AGENDAR' && (
            <form className="grid gap-2 rounded-md border p-3 sm:grid-cols-2" onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              acao(`/api/pedidos/${id}/agendar`, {
                data: localParaIso(String(f.get('data'))), instaladorId: f.get('instalador'),
                duracaoHoras: f.get('duracao') || null, observacoes: f.get('obs') || null,
              }, 'Instalação agendada.');
            }}>
              <label className="flex flex-col gap-1">Data e hora<Input type="datetime-local" name="data" required defaultValue={isoParaLocal(p.instalacaoAgendada)} /></label>
              <label className="flex flex-col gap-1">Instalador
                <select name="instalador" className={classeSelect} required defaultValue={p.instaladorId ?? ''}>
                  <option value="" disabled>Escolha</option>
                  {instaladores.map((f) => <option key={f.id} value={f.id}>{f.nomeFantasia}</option>)}
                </select>
                {instaladores.length === 0 && <span className="text-xs text-muted-foreground">Cadastre o instalador em Fornecedores (categoria Instalador).</span>}
              </label>
              <label className="flex flex-col gap-1">Duração (horas)<Input name="duracao" inputMode="decimal" placeholder="Ex.: 3" defaultValue={p.duracaoHoras ?? ''} /></label>
              <label className="flex flex-col gap-1 sm:col-span-2">Observações para o instalador<textarea name="obs" className={classeTextarea} defaultValue={p.obsInstalacao ?? ''} /></label>
              <div className="sm:col-span-2"><Button disabled={ocupado}>Salvar agenda</Button></div>
            </form>
          )}
          {painel === 'ADITIVO' && (
            <form className="flex flex-wrap items-end gap-2 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); abrirAditivo(String(new FormData(e.currentTarget).get('motivo') ?? '')); }}>
              <Input name="motivo" className="w-72" placeholder="O que o cliente pediu (ex.: incluir bandô)" />
              <Button disabled={ocupado}>Abrir aditivo</Button>
            </form>
          )}
          {painel === 'CANCELAR' && (
            <form className="flex flex-wrap items-end gap-2 rounded-md border border-destructive/40 p-3" onSubmit={(e) => {
              e.preventDefault();
              acao(`/api/pedidos/${id}/cancelar`, { motivo: String(new FormData(e.currentTarget).get('motivo') ?? '') }, 'Pedido cancelado.');
            }}>
              <Input name="motivo" className="w-72" required minLength={3} placeholder="Motivo do cancelamento" />
              <Button variant="destructive" disabled={ocupado}>Confirmar cancelamento</Button>
            </form>
          )}
        </CardContent>
      </Card>

      {/* Itens */}
      <Card>
        <CardHeader><CardTitle>Itens</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {[...grupos.entries()].map(([amb, itens]) => (
            <div key={amb}>
              <div className="font-medium">{amb}</div>
              {itens.map((i) => (
                <div key={i.id} className="flex gap-2 border-t py-1">
                  <span className="flex-1">{i.descricaoComercial}<span className="block text-xs text-muted-foreground">{metros(i.larguraProducao)} x {metros(i.alturaProducao)}</span></span>
                  <span>{moeda(i.vendaTotal)}</span>
                </div>
              ))}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Valores */}
      <Card>
        <CardHeader><CardTitle>Valores</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-sm sm:grid-cols-2">
          <Linha r="Total do pedido" v={moeda(p.valorTotal)} forte />
          {p.valorOriginal && p.valorOriginal !== p.valorTotal && <Linha r="Valor na aprovação" v={moeda(p.valorOriginal)} />}
          <Linha r="Forma combinada" v={FORMAS.find(([k]) => k === p.formaPagamento)?.[1] ?? 'A definir'} />
          {p.sinalValor && <Linha r={`Sinal (${dataBR(p.sinalRecebidoEm)})`} v={moeda(p.sinalValor)} />}
          {p.liberadoSemSinal && <Linha r="Sinal" v="Liberado sem sinal" />}
          <Linha r="Saldo a receber" v={moeda(p.saldo)} forte />
          {p.custoPrevisto && <Linha r="Custo previsto" v={moeda(p.custoPrevisto)} />}
          {p.custoReal != null && p.custoPrevisto && Number(p.custoReal) > 0 && <Linha r="Custo real (recebido até agora)" v={moeda(p.custoReal)} />}
          {p.previsaoEntrega && <Linha r="Entrega prevista" v={`${dataBR(p.previsaoEntrega)} (dias úteis)`} />}
          <p className="text-xs text-muted-foreground sm:col-span-2">Contas a receber e a pagar completas entram na fase do financeiro.</p>
        </CardContent>
      </Card>

      {/* Documentos */}
      <Card>
        <CardHeader><CardTitle>Documentos</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline"><a href={`/api/orcamentos/${p.orcamentoId}/proposta.pdf`} target="_blank" rel="noopener">Proposta (cliente)</a></Button>
          <Button asChild variant="outline"><a href={`/api/pedidos/${id}/os.pdf`} target="_blank" rel="noopener">OS de instalação</a></Button>
          <Button variant="outline" onClick={linkOs}>WhatsApp: OS para o instalador</Button>
          {admin && <Button asChild variant="outline"><a href={`/api/pedidos/${id}/producao.pdf?tipo=CORTINA`} target="_blank" rel="noopener">Ficha de corte</a></Button>}
          {admin && <Button asChild variant="outline"><a href={`/api/pedidos/${id}/producao.pdf?tipo=PERSIANA`} target="_blank" rel="noopener">Pedido de fábrica</a></Button>}
          {p.aceite && <Button asChild variant="outline"><a href={`/api/pedidos/${id}/termo-aceite.pdf`} target="_blank" rel="noopener">Termo de aceite assinado</a></Button>}
        </CardContent>
      </Card>

      {/* Compras */}
      {admin && p.compras.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Compras e produção</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {p.compras.map((o) => (
              <CartaoOrdem key={o.id} ordem={o} onMudou={carregar} onErro={(m, okMsg) => { setErro(m); setOk(okMsg ?? null); }} />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Nota fiscal */}
      {tem('REGISTRAR_NF') && (
        <Card>
          <CardHeader><CardTitle>Nota fiscal</CardTitle></CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">As notas são emitidas no portal do governo. Aqui só fica o registro do número.</p>
            <form className="grid gap-2 text-sm sm:grid-cols-3" onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              acao(`/api/pedidos/${id}/nota-fiscal`, { nfeNumero: f.get('nfe') || null, nfeChave: f.get('chave') || null, nfseNumero: f.get('nfse') || null }, 'Nota registrada.');
            }}>
              <label className="flex flex-col gap-1">NF-e (produto)<Input name="nfe" defaultValue={p.nfeNumero ?? ''} /></label>
              <label className="flex flex-col gap-1">Chave da NF-e (44 dígitos)<Input name="chave" inputMode="numeric" defaultValue={p.nfeChave ?? ''} /></label>
              <label className="flex flex-col gap-1">NFS-e (instalação)<Input name="nfse" defaultValue={p.nfseNumero ?? ''} /></label>
              <div className="sm:col-span-3"><Button variant="outline" disabled={ocupado}>Salvar nota</Button></div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Aceite */}
      {p.aceite && (
        <Card>
          <CardHeader><CardTitle>Aceite do cliente</CardTitle></CardHeader>
          <CardContent className="text-sm">
            Assinado por {p.aceite.nomeRecebedor} em {dataHoraBR(p.aceite.assinadoEm)}{p.aceite.offline ? ' (no aparelho, sem internet)' : ''}.
            {p.aceite.ressalvas && <span className="text-red-700 dark:text-red-400"> Com ressalvas.</span>}
            {p.aceite.observacoes && <p className="mt-1 text-muted-foreground">{p.aceite.observacoes}</p>}
          </CardContent>
        </Card>
      )}

      {/* Aditivos e histórico */}
      <Card>
        <CardHeader><CardTitle>Aditivos e histórico</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {p.aditivos.length > 0 && (
            <ul className="space-y-1">
              {p.aditivos.map((a) => (
                <li key={a.id} className="flex flex-wrap gap-2 border-t pt-1">
                  <span className="font-medium">Aditivo {a.numero}</span>
                  <span>{a.tipo === 'CONFERENCIA_MEDIDAS' ? 'medição' : 'alteração'}</span>
                  <Badge className="text-muted-foreground">{a.status === 'RASCUNHO' ? 'Em aberto' : a.status === 'CONFIRMADO' ? 'Confirmado' : 'Descartado'}</Badge>
                  {a.diferenca != null && <span>{Number(a.diferenca) >= 0 ? '+' : ''}{moeda(a.diferenca)}</span>}
                  {a.motivo && <span className="text-muted-foreground">{a.motivo}</span>}
                </li>
              ))}
            </ul>
          )}
          <ul className="space-y-1">
            {p.eventos.map((e) => (
              <li key={e.id} className="border-t pt-1">
                <span className="text-xs text-muted-foreground">{dataHoraBR(e.criadoEm)}{e.usuario ? ` · ${e.usuario}` : ''}{e.offline ? ' · offline' : ''}</span>
                <div>{e.descricao}</div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function Linha({ r, v, forte }: { r: string; v: string; forte?: boolean }) {
  return <div className="flex justify-between gap-2 border-b py-1"><span className="text-muted-foreground">{r}</span><span className={forte ? 'font-semibold' : ''}>{v}</span></div>;
}

function FormSinal({ p, ocupado, onSinal }: { p: Pedido; ocupado: boolean; onSinal: (c: object) => void }) {
  const [semSinal, setSemSinal] = useState(false);
  const metade = (Number(p.valorTotal) / 2).toFixed(2).replace('.', ',');
  return (
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      onSinal(semSinal ? { semSinal: true, motivo: f.get('motivo') || null } : { valor: f.get('valor'), forma: f.get('forma'), recebidoEm: f.get('data') });
    }}>
      <p>Confirme o sinal para liberar as compras. As ordens por fornecedor são geradas na hora.</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={semSinal} onChange={(e) => setSemSinal(e.target.checked)} /> Liberar sem sinal (decisão do administrador)</label>
      {semSinal ? (
        <Input name="motivo" className="w-72" placeholder="Motivo (opcional)" />
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1">Valor do sinal<Input name="valor" inputMode="decimal" required defaultValue={metade} /></label>
          <label className="flex flex-col gap-1">Forma
            <select name="forma" className={classeSelect} defaultValue={p.formaPagamento ?? 'PIX'}>
              {FORMAS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">Recebido em<Input type="date" name="data" required defaultValue={hojeISO()} /></label>
        </div>
      )}
      <Button disabled={ocupado}>{semSinal ? 'Liberar compras sem sinal' : 'Confirmar sinal e liberar compras'}</Button>
    </form>
  );
}
