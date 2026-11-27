'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { sugerirControles, type Ajuste, type Catalogo } from '@sistema/motor-calculo/navegador';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { classeSelect, classeTextarea, Mensagens } from '@/components/cadastro/campos';
import {
  abrirOrcamento, calcularLocal, carregarCatalogo, chamar, ErroApi, gravarOrcamento,
  type Item, type Orcamento, type ProdutoCatalogo,
} from '@/lib/orcamentos-offline';
import { FormItem } from './form-item';
import { TabelaComponentes } from './componentes';
import { corSemaforo, FORMAS, metros, moeda, nomeSemaforo, pct, STATUS } from './formato';

type Props = { id: string; admin: boolean; verCusto: boolean; recado?: string | null; onVoltar: () => void; onTrocarId: (id: string, mensagem?: string) => void };
type Evento = { id: string; versao: number; acao: string; descricao: string; offline: boolean; criadoEm: string; usuario: string | null };
type Versao = { id: string; versao: number; status: string; total: string; enviadoEm: string | null };

export function EditorOrcamento({ id, admin, verCusto, recado, onVoltar, onTrocarId }: Props) {
  const [doc, setDoc] = useState<Orcamento | null>(null);
  const [transicoes, setTransicoes] = useState<string[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [produtos, setProdutos] = useState<ProdutoCatalogo[]>([]);
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [form, setForm] = useState<string | null>(null); // id do item em edição ou 'novo'
  const [ambienteNovo, setAmbienteNovo] = useState<string | undefined>();
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(recado ?? null);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [detalhar, setDetalhar] = useState(false);
  const [historico, setHistorico] = useState<{ eventos: Evento[]; versoes: Versao[] } | null>(null);
  const [motivoPerda, setMotivoPerda] = useState('');
  const [podeAprovar, setPodeAprovar] = useState(false);
  const [aprovacao, setAprovacao] = useState<{ medidasConferidas: boolean; formaPagamento: string } | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const [r, cat] = await Promise.all([abrirOrcamento(id), carregarCatalogo().catch(() => null)]);
      if (cat) { setProdutos(cat.produtos); setCatalogo(cat.catalogo); }
      if (r) { setDoc(r.orcamento); setTransicoes(r.transicoes); setPodeAprovar(Boolean(r.podeAprovar)); }
      setHistorico(null);
    } catch (e) { setErro((e as Error).message); }
    setCarregando(false);
  }, [id]);
  useEffect(() => { carregar(); }, [carregar]);

  const ambientes = useMemo(() => [...new Set(doc?.itens.map((i) => i.ambiente) ?? [])], [doc]);
  const grupos = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of doc?.itens ?? []) m.set(i.ambiente, [...(m.get(i.ambiente) ?? []), i]);
    return [...m.entries()];
  }, [doc]);

  /** Aplica a mudança: calcula no aparelho na hora e grava (servidor recalcula o oficial). */
  async function aplicar(novo: Orcamento, opcoes: { atualizarPrecos?: boolean; mensagem?: string } = {}) {
    setErro(null); setOk(null); setAvisos([]);
    let previa = novo;
    if (catalogo) {
      try { previa = calcularLocal(novo, catalogo, verCusto); } catch (e) { setErro((e as Error).message); return false; }
    }
    setDoc(previa);
    setSalvando(true);
    try {
      const r = await gravarOrcamento(previa, opcoes);
      setDoc(r.orcamento);
      setAvisos(r.avisos);
      if (!r.offline) setOk(opcoes.mensagem ?? 'Salvo.');
      if (r.novaVersao && r.orcamento.id !== id) { onTrocarId(r.orcamento.id, `Salvo como v${r.orcamento.versao}. ${r.avisos.join(' ')}`); return true; }
      if (!r.offline) {
        const t = await chamar<{ transicoes: string[] }>(`/api/orcamentos/${r.orcamento.id}`).catch(() => null);
        if (t) setTransicoes(t.transicoes);
      }
      setHistorico(null);
      return true;
    } catch (e) {
      setErro((e as Error).message);
      await carregar();
      return false;
    } finally { setSalvando(false); }
  }

  async function acao(caminho: string, corpo: unknown, mensagem: string) {
    setErro(null); setOk(null); setAvisos([]);
    setSalvando(true);
    try {
      const r = await chamar<{ orcamento: Orcamento }>(caminho, 'POST', corpo);
      if (r.orcamento.id !== id) { onTrocarId(r.orcamento.id, mensagem); return r; }
      await carregar();
      setOk(mensagem);
      return r;
    } catch (e) {
      const dados = e instanceof ErroApi ? e.dados : {};
      setErro(e instanceof ErroApi ? e.message : 'Sem internet: esta ação precisa de conexão.');
      if (dados.exigeLiberacao) await carregar();
      return null;
    } finally { setSalvando(false); }
  }

  async function whatsapp() {
    setErro(null);
    try {
      const r = await chamar<{ whatsapp: string | null; url: string }>(`/api/orcamentos/${id}/link-publico`, 'POST', { detalhar, origem: window.location.origin });
      if (r.whatsapp) window.open(r.whatsapp, '_blank', 'noopener');
      else setOk(`Link da proposta: ${r.url}`);
    } catch (e) { setErro(e instanceof ErroApi ? e.message : 'Sem internet: o link precisa de conexão.'); }
  }

  /** Cliente aprovou: o orçamento vira pedido (precisa de internet). */
  async function aprovar() {
    if (!aprovacao) return;
    setErro(null); setOk(null); setSalvando(true);
    try {
      const r = await chamar<{ pedido: { id: string } }>(`/api/orcamentos/${id}/aprovar`, 'POST', {
        medidasConferidas: aprovacao.medidasConferidas, formaPagamento: aprovacao.formaPagamento || null,
      });
      window.location.href = `/pedidos?p=${r.pedido.id}`;
    } catch (e) {
      setErro(e instanceof ErroApi ? e.message : 'Sem internet: a aprovação precisa de conexão.');
      setSalvando(false);
    }
  }

  async function abrirHistorico() {
    try {
      const [ev, ve] = await Promise.all([
        chamar<{ eventos: Evento[] }>(`/api/orcamentos/${id}/auditoria`),
        chamar<{ versoes: Versao[] }>(`/api/orcamentos/${id}/versoes`),
      ]);
      setHistorico({ eventos: ev.eventos, versoes: ve.versoes });
    } catch { setErro('O histórico só abre com internet.'); }
  }

  if (carregando && !doc) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (!doc) return <div className="space-y-3"><Mensagens erro={erro ?? 'Orçamento não encontrado.'} /><Button variant="outline" onClick={onVoltar}>Voltar</Button></div>;

  const editavel = doc.editavel && !salvando;
  const t = doc.totais;
  const verCustoDoc = doc.podeVerCustos ?? verCusto;
  const lib = doc.liberacao;
  const ultimaVersao = !doc.versaoMaisNovaId || doc.versaoMaisNovaId === doc.id;
  /** Controle é pela casa toda (Gabriel, 27/11/2026): se já há um no orçamento, a nova persiana vem sem. */
  const temControleNoOrcamento = (ignorar?: string) => doc.itens.some((i) => i.id !== ignorar && i.tipo === 'PERSIANA'
    && (i.entrada as { acionamento?: string; qtdControles?: number }).acionamento === 'MOTORIZADO'
    && ((i.entrada as { qtdControles?: number }).qtdControles ?? 1) > 0);

  function salvarItem(item: Item) {
    const existe = doc!.itens.some((i) => i.id === item.id);
    const itens = existe ? doc!.itens.map((i) => (i.id === item.id ? item : i)) : [...doc!.itens, item];
    aplicar({ ...doc!, itens }, { mensagem: existe ? 'Item atualizado.' : 'Item incluído.' }).then((foi) => { if (foi) setForm(null); });
  }
  type EntradaPersiana = { acionamento?: string; qtdControles?: number; numPecas?: number; skus?: Record<string, string> };
  /** Controles da casa toda: soma as peças motorizadas do orçamento; cada canal aciona 1 peça (Gabriel, 27/11/2026). */
  function controlesDaCasa(itens: Item[]) {
    const motorizadas = itens.filter((i) => i.tipo === 'PERSIANA' && (i.entrada as EntradaPersiana).acionamento === 'MOTORIZADO');
    if (motorizadas.length === 0) return null;
    const pecas = motorizadas.reduce((s, i) => s + ((i.entrada as EntradaPersiana).numPecas ?? 1), 0);
    const opcoes = produtos.filter((p) => Number(p.metadata?.canais) > 0).map((p) => ({ sku: p.sku, canais: Number(p.metadata.canais) }));
    const sugestao = sugerirControles(pecas, opcoes);
    const atual = motorizadas.flatMap((i) => {
      const e = i.entrada as EntradaPersiana;
      const q = e.qtdControles ?? 1;
      return q > 0 ? [{ sku: e.skus?.controle ?? 'MOT-002', quantidade: q }] : [];
    });
    const chave = (l: { sku: string; quantidade: number }[]) => l.map((x) => `${x.sku}x${x.quantidade}`).sort().join(',');
    const nome = (sku: string) => produtos.find((p) => p.sku === sku)?.nome ?? sku;
    return {
      pecas, motorizadas, sugestao, atual, nome,
      igual: chave(atual) === chave(sugestao.map((x) => ({ sku: x.sku, quantidade: x.quantidade }))),
    };
  }
  /** Põe os controles sugeridos nas primeiras persianas motorizadas do orçamento; as outras ficam sem. */
  function aplicarSugestaoControles() {
    const info = controlesDaCasa(doc!.itens);
    if (!info) return;
    const fila = info.sugestao.flatMap((x) => [{ sku: x.sku, quantidade: x.quantidade }]);
    let n = 0;
    const itens = doc!.itens.map((i) => {
      if (!info.motorizadas.some((m) => m.id === i.id)) return i;
      const e = i.entrada as EntradaPersiana;
      const c = fila[n++];
      return { ...i, entrada: { ...e, qtdControles: c?.quantidade ?? 0, skus: { ...e.skus, ...(c ? { controle: c.sku } : {}) } } };
    });
    aplicar({ ...doc!, itens }, { mensagem: 'Controles remotos ajustados.' });
  }

  function removerItem(item: Item) {
    aplicar({ ...doc!, itens: doc!.itens.filter((i) => i.id !== item.id) }, { mensagem: 'Item removido.' });
  }
  function ajustar(item: Item, ajustes: Ajuste[]) {
    aplicar({ ...doc!, itens: doc!.itens.map((i) => (i.id === item.id ? { ...i, ajustes } : i)) }, { mensagem: 'Componente ajustado.' });
  }
  function salvarCondicoes(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const n = (k: string) => (s(k) === '' ? null : Number(s(k)));
    aplicar({
      ...doc!,
      titulo: s('titulo') || null,
      condicoes: {
        descontoTipo: s('descontoTipo') as 'PERCENTUAL' | 'VALOR', descontoValor: s('descontoValor').replace(',', '.') || '0',
        acrescimo: s('acrescimo').replace(',', '.') || '0', formaPagamento: s('formaPagamento') || null, parcelas: n('parcelas') ?? 1,
        validadeAte: s('validadeAte') || null, prazoEntregaDias: n('prazoEntregaDias'), garantiaTexto: s('garantiaTexto') || null,
        condicoesPagamentoTexto: s('condicoesPagamentoTexto') || null, observacoesCliente: s('observacoesCliente') || null,
        observacoesInternas: s('observacoesInternas') || null, medidasConferidas: f.get('medidasConferidas') === 'on',
      },
    }, { mensagem: 'Condições salvas.' });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onVoltar}>← Orçamentos</Button>
        <h1 className="text-xl font-semibold">{doc.codigo ?? 'Novo orçamento'}{doc.versao ? ` · v${doc.versao}` : ''}</h1>
        <Badge>{STATUS[doc.status] ?? doc.status}</Badge>
        {doc.pendente && <Badge className="border-amber-500/50 text-amber-700 dark:text-amber-400">Guardado no aparelho</Badge>}
        {doc.provisorio && !doc.pendente && salvando && <Badge className="text-muted-foreground">Salvando…</Badge>}
        {doc.congeladoEm && <Badge className="text-muted-foreground">Congelado</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">
        {doc.clienteNome}{doc.titulo ? ` · ${doc.titulo}` : ''}{doc.vendedorNome ? ` · vendedor ${doc.vendedorNome}` : ''}
      </p>

      <Mensagens erro={erro ?? doc.erroSync} ok={ok} avisos={avisos} />
      {!ultimaVersao && (
        <p className="rounded-md border px-3 py-2 text-sm">
          Esta é uma versão antiga.{' '}
          <button type="button" className="underline" onClick={() => onTrocarId(doc.versaoMaisNovaId!)}>Abrir a v{doc.versaoMaisNova}</button>
        </p>
      )}
      {doc.aditivo && doc.pedidoId && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          Este rascunho é o <strong>aditivo do pedido {doc.pedidoNumero}</strong>. Ajuste medidas e itens aqui; depois confirme (ou descarte) no{' '}
          <a className="underline" href={`/pedidos?p=${doc.pedidoId}`}>pedido</a>.
        </p>
      )}
      {doc.status === 'APROVADO' && doc.pedidoId && (
        <p className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm">
          Aprovado pelo cliente: virou o <a className="font-medium underline" href={`/pedidos?p=${doc.pedidoId}`}>pedido {doc.pedidoNumero}</a>.
          Mudanças agora são feitas por aditivo, no pedido.
        </p>
      )}
      {!doc.editavel && ultimaVersao && doc.status !== 'PERDIDO' && doc.status !== 'APROVADO' && (
        <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
          Versão enviada ao cliente: os valores estão congelados. Para mudar (ex.: depois da medição), crie uma nova versão.
        </p>
      )}

      {/* Itens por ambiente */}
      <Card>
        <CardHeader><CardTitle>Ambientes e itens</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {doc.itens.length === 0 && <p className="text-sm text-muted-foreground">Nenhum item ainda. Inclua o primeiro vão.</p>}
          {(() => {
            const c = controlesDaCasa(doc.itens);
            if (!c) return null;
            const txt = (l: { sku: string; quantidade: number }[]) => (l.length ? l.map((x) => `${x.quantidade}x ${c.nome(x.sku)}`).join(' + ') : 'nenhum');
            return (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
                <span>Casa toda: {c.pecas} peça(s) motorizada(s) · controles: {txt(c.atual)}</span>
                {!c.igual && c.sugestao.length > 0 && (
                  <>
                    <span className="text-muted-foreground">Sugestão: {txt(c.sugestao)}</span>
                    {editavel && <Button size="sm" variant="outline" onClick={() => aplicarSugestaoControles()}>Usar sugestão</Button>}
                  </>
                )}
              </div>
            );
          })()}
          {grupos.map(([amb, itens]) => (
            <div key={amb} className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{amb}</h3>
                {editavel && <Button size="sm" variant="ghost" onClick={() => { setAmbienteNovo(amb); setForm('novo'); }}>+ item em {amb}</Button>}
              </div>
              {itens.map((i) => (
                <div key={i.id} className="rounded-md border p-3">
                  {form === i.id ? (
                    <FormItem produtos={produtos} ambientes={ambientes} inicial={i} temControleNoOrcamento={temControleNoOrcamento}
                      onSalvar={salvarItem} onCancelar={() => setForm(null)} />
                  ) : (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium">{i.descricaoComercial || 'Item'}</p>
                          <p className="text-xs text-muted-foreground">
                            Produção {metros(i.larguraProducao)} x {metros(i.alturaProducao)}
                            {i.ajustes.length > 0 && ` · ${i.ajustes.length} ajuste(s) manual(is)`}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold">{moeda(i.vendaTotal)}</p>
                          {i.descontoRateado && Number(i.descontoRateado) > 0 && <p className="text-xs text-muted-foreground">líquido {moeda(i.vendaLiquida)}</p>}
                          {verCustoDoc && i.custoTotal && <p className="text-xs text-muted-foreground">custo {moeda(i.custoTotal)}</p>}
                        </div>
                      </div>
                      {(i.alertas?.length ?? 0) > 0 && (
                        <div role="alert" className="mt-2 space-y-1">
                          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">⚠ Atenção (só para você, não vai para a proposta)</p>
                          {i.alertas!.map((a) => (
                            <p key={a.codigo + a.mensagem} className={`rounded border px-2 py-1 text-sm ${a.severidade === 'CRITICO' ? 'border-red-500/60 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300' : 'border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200'}`}>{a.mensagem}</p>
                          ))}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setAbertos((s) => { const n = new Set(s); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })}>
                          {abertos.has(i.id) ? 'Ocultar componentes' : `Componentes (${i.componentes?.length ?? 0})`}
                        </Button>
                        {editavel && <Button size="sm" variant="outline" onClick={() => setForm(i.id)}>Editar</Button>}
                        {editavel && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => removerItem(i)}>Remover</Button>}
                      </div>
                      {abertos.has(i.id) && (
                        <div className="mt-3">
                          <TabelaComponentes item={i} produtos={produtos} editavel={editavel} verCusto={verCustoDoc} onAjustes={(a) => ajustar(i, a)} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
          {form === 'novo' ? (
            <FormItem produtos={produtos} ambientes={ambientes} ambienteSugerido={ambienteNovo} temControleNoOrcamento={temControleNoOrcamento}
              onSalvar={salvarItem} onCancelar={() => setForm(null)} />
          ) : editavel && (
            <Button onClick={() => { setAmbienteNovo(undefined); setForm('novo'); }}>Incluir item (novo ambiente ou vão)</Button>
          )}
          {produtos.length === 0 && <p className="text-xs text-muted-foreground">Catálogo não carregado: abra o app com internet uma vez para usar na obra.</p>}
        </CardContent>
      </Card>

      {/* Totais e semáforo */}
      <Card>
        <CardHeader><CardTitle>Total</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          <Linha rotulo="Subtotal" valor={moeda(t?.subtotal)} />
          {t && Number(t.descontoValor) > 0 && <Linha rotulo={`Desconto (${pct(t.descontoPct)})`} valor={`- ${moeda(t.descontoValor)}`} />}
          {t && Number(t.acrescimo) > 0 && <Linha rotulo="Acréscimo" valor={moeda(t.acrescimo)} />}
          <Linha rotulo="Total" valor={moeda(t?.total)} forte />
          {verCustoDoc && t?.custoTotal && (
            <div className="mt-2 space-y-1 border-t pt-2 text-muted-foreground">
              <Linha rotulo="Custo previsto" valor={moeda(t.custoTotal)} />
              {t.taxaPagamento && Number(t.taxaPagamento) > 0 && <Linha rotulo={`Taxa de pagamento (${pct(t.taxaPagamentoPct)})`} valor={moeda(t.taxaPagamento)} />}
              {t.comissao && Number(t.comissao) > 0 && <Linha rotulo={`Comissão (${pct(t.comissaoPct)})`} valor={moeda(t.comissao)} />}
              {t.lucroLiquido && <Linha rotulo="Lucro líquido previsto" valor={moeda(t.lucroLiquido)} />}
              <Linha rotulo="Margem líquida" valor={pct(t.margemLiquidaPct)} />
            </div>
          )}
          <div className="pt-2">
            <Badge className={corSemaforo(t?.semaforo)}>{doc.provisorio && !verCustoDoc ? 'Margem conferida ao sincronizar' : nomeSemaforo(t?.semaforo)}</Badge>
            {doc.provisorio && <span className="ml-2 text-xs text-muted-foreground">Cálculo do aparelho (provisório)</span>}
          </div>
          {lib?.pendente && (
            <Liberacao motivos={lib.motivos} admin={admin} salvando={salvando}
              onLiberar={(corpo) => acao(`/api/orcamentos/${id}/liberar`, corpo, 'Liberado pelo administrador.')} />
          )}
          {lib?.liberado && <p className="text-xs text-muted-foreground">Liberado por {lib.liberadoPorNome}.</p>}
        </CardContent>
      </Card>

      {doc.teto && doc.itens.length > 0 && <TetoNegociacao teto={doc.teto} desatualizado={!!doc.provisorio} />}

      {/* Condições */}
      <Card>
        <CardHeader><CardTitle>Condições da proposta</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={salvarCondicoes} className="grid gap-4 sm:grid-cols-2" key={`${doc.id}-${doc.atualizadoEm}`}>
            <fieldset disabled={!editavel} className="contents">
              <Campo nome="titulo" rotulo="Projeto / obra" valor={doc.titulo} largo />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="descontoTipo">Desconto</Label>
                <div className="flex gap-2">
                  <select id="descontoTipo" name="descontoTipo" defaultValue={doc.condicoes.descontoTipo} className={`${classeSelect} w-24`}>
                    <option value="PERCENTUAL">%</option><option value="VALOR">R$</option>
                  </select>
                  <Input name="descontoValor" inputMode="decimal" defaultValue={doc.condicoes.descontoValor.replace('.', ',')} />
                </div>
              </div>
              <Campo nome="acrescimo" rotulo="Acréscimo (R$)" valor={doc.condicoes.acrescimo.replace('.', ',')} />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="formaPagamento">Forma de pagamento</Label>
                <select id="formaPagamento" name="formaPagamento" defaultValue={doc.condicoes.formaPagamento ?? ''} className={classeSelect}>
                  <option value="">A combinar</option>
                  {FORMAS.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
                </select>
              </div>
              <Campo nome="parcelas" rotulo="Parcelas" valor={String(doc.condicoes.parcelas)} tipo="number" />
              <Campo nome="validadeAte" rotulo="Validade" valor={doc.condicoes.validadeAte} tipo="date" />
              <Campo nome="prazoEntregaDias" rotulo="Prazo de entrega (dias úteis)" valor={doc.condicoes.prazoEntregaDias == null ? '' : String(doc.condicoes.prazoEntregaDias)} tipo="number" />
              <Campo nome="condicoesPagamentoTexto" rotulo="Condições de pagamento (texto)" valor={doc.condicoes.condicoesPagamentoTexto} largo dica="Ex.: 50% de sinal e 50% na instalação" />
              <Campo nome="garantiaTexto" rotulo="Garantia" valor={doc.condicoes.garantiaTexto} largo dica="Em branco: prazo por item (12 meses; rolo, double vision e painel 2 anos; motor 5 anos)" />
              <Area nome="observacoesCliente" rotulo="Observações para o cliente (vão no PDF)" valor={doc.condicoes.observacoesCliente} />
              <Area nome="observacoesInternas" rotulo="Observações internas (não vão no PDF)" valor={doc.condicoes.observacoesInternas} />
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" name="medidasConferidas" defaultChecked={doc.condicoes.medidasConferidas} />
                Medidas conferidas no local (tira o aviso &quot;sujeitos a conferência técnica&quot; do PDF)
              </label>
              {editavel && <div className="sm:col-span-2"><Button type="submit">Salvar condições</Button></div>}
            </fieldset>
          </form>
        </CardContent>
      </Card>

      {/* Ações */}
      <Card>
        <CardHeader><CardTitle>Proposta e andamento</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={detalhar} onChange={(e) => setDetalhar(e.target.checked)} /> Detalhar componentes no PDF
          </label>
          <div className="flex flex-wrap gap-2">
            {doc.codigo && !doc.pendente && (
              lib?.pendente
                ? <Button variant="outline" disabled>PDF (precisa liberar)</Button>
                : <Button asChild variant="outline"><a href={`/api/orcamentos/${doc.id}/proposta.pdf${detalhar ? '?detalhar=1' : ''}`} target="_blank" rel="noopener">Ver PDF</a></Button>
            )}
            {transicoes.includes('ENVIADO') && (
              <Button disabled={salvando || doc.itens.length === 0} onClick={() => acao(`/api/orcamentos/${id}/status`, { status: 'ENVIADO' }, 'Proposta enviada: esta versão ficou congelada.')}>
                Enviar proposta (congela a versão)
              </Button>
            )}
            {doc.status !== 'RASCUNHO' && doc.status !== 'PERDIDO' && ultimaVersao && <Button variant="outline" onClick={whatsapp}>Mandar no WhatsApp</Button>}
            {transicoes.includes('AGUARDANDO_MEDICAO') && <Button variant="outline" onClick={() => acao(`/api/orcamentos/${id}/status`, { status: 'AGUARDANDO_MEDICAO' }, 'Aguardando medição.')}>Aguardando medição</Button>}
            {transicoes.includes('EM_NEGOCIACAO') && <Button variant="outline" onClick={() => acao(`/api/orcamentos/${id}/status`, { status: 'EM_NEGOCIACAO' }, 'Em negociação.')}>Em negociação</Button>}
            {!doc.editavel && ultimaVersao && ['ENVIADO', 'AGUARDANDO_MEDICAO', 'EM_NEGOCIACAO', 'EXPIRADO'].includes(doc.status) && (
              <>
                <Button variant="outline" onClick={() => acao(`/api/orcamentos/${id}/nova-versao`, {}, 'Nova versão criada (mesmos preços).')}>Nova versão</Button>
                <Button variant="ghost" onClick={() => acao(`/api/orcamentos/${id}/nova-versao`, { atualizarPrecos: true }, 'Nova versão com os preços de hoje.')}>Nova versão com preços de hoje</Button>
              </>
            )}
            {doc.editavel && doc.codigo && doc.itens.length > 0 && (
              <Button variant="ghost" onClick={() => aplicar(doc, { atualizarPrecos: true, mensagem: 'Preços atualizados pelo catálogo.' })}>Atualizar preços pelo catálogo</Button>
            )}
          </div>
          {podeAprovar && ultimaVersao && (
            <div className="space-y-2 border-t pt-3">
              {!aprovacao ? (
                <Button disabled={salvando} onClick={() => setAprovacao({ medidasConferidas: doc.condicoes.medidasConferidas, formaPagamento: doc.condicoes.formaPagamento ?? '' })}>
                  Cliente aprovou: virar pedido
                </Button>
              ) : (
                <div className="space-y-3 rounded-md border p-3 text-sm">
                  <p className="font-medium">Aprovar a v{doc.versao} ({t ? moeda(t.total) : ''}) e criar o pedido</p>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={aprovacao.medidasConferidas}
                      onChange={(e) => setAprovacao({ ...aprovacao, medidasConferidas: e.target.checked })} />
                    <span>As medidas já foram conferidas no local.
                      <span className="block text-xs text-muted-foreground">Sem marcar, o pedido fica em &quot;Conferência de medidas&quot; e as compras só saem depois da medição.</span>
                    </span>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>Forma de pagamento combinada</span>
                    <select className={classeSelect} value={aprovacao.formaPagamento} onChange={(e) => setAprovacao({ ...aprovacao, formaPagamento: e.target.value })}>
                      <option value="">A definir</option>
                      {FORMAS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                    </select>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={salvando} onClick={aprovar}>Confirmar aprovação</Button>
                    <Button variant="ghost" onClick={() => setAprovacao(null)}>Cancelar</Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {transicoes.includes('PERDIDO') && (
            <div className="flex flex-wrap items-end gap-2 border-t pt-3">
              <Input className="w-64" placeholder="Motivo da perda (ex.: preço, prazo)" value={motivoPerda} onChange={(e) => setMotivoPerda(e.target.value)} />
              <Button variant="ghost" className="text-destructive" disabled={!motivoPerda.trim()}
                onClick={() => acao(`/api/orcamentos/${id}/status`, { status: 'PERDIDO', motivoPerda }, 'Marcado como perdido.')}>Marcar como perdido</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Histórico */}
      {doc.codigo && !doc.pendente && (
        <Card>
          <CardHeader><CardTitle>Versões e histórico</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!historico ? <Button variant="outline" size="sm" onClick={abrirHistorico}>Ver versões e alterações</Button> : (
              <>
                <div className="flex flex-wrap gap-2">
                  {historico.versoes.map((v) => (
                    <Button key={v.id} size="sm" variant={v.id === doc.id ? 'default' : 'outline'} onClick={() => v.id !== doc.id && onTrocarId(v.id)}>
                      v{v.versao} · {STATUS[v.status] ?? v.status} · {moeda(v.total)}
                    </Button>
                  ))}
                </div>
                <ul className="space-y-1">
                  {historico.eventos.map((e) => (
                    <li key={e.id} className="border-t pt-1">
                      <span className="text-xs text-muted-foreground">{new Date(e.criadoEm).toLocaleString('pt-BR')} · v{e.versao} · {e.usuario ?? ''}{e.offline ? ' · offline' : ''}</span>
                      <div>{e.descricao}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Linha({ rotulo, valor, forte }: { rotulo: string; valor: string; forte?: boolean }) {
  return <div className={`flex justify-between ${forte ? 'text-base font-semibold' : ''}`}><span>{rotulo}</span><span>{valor}</span></div>;
}

function Campo({ nome, rotulo, valor, largo, tipo, dica }: { nome: string; rotulo: string; valor: string | null | undefined; largo?: boolean; tipo?: string; dica?: string }) {
  return (
    <div className={`flex flex-col gap-1.5 ${largo ? 'sm:col-span-2' : ''}`}>
      <Label htmlFor={nome}>{rotulo}</Label>
      <Input id={nome} name={nome} type={tipo ?? 'text'} defaultValue={valor ?? ''} />
      {dica && <span className="text-xs text-muted-foreground">{dica}</span>}
    </div>
  );
}

function Area({ nome, rotulo, valor }: { nome: string; rotulo: string; valor: string | null }) {
  return (
    <div className="flex flex-col gap-1.5 sm:col-span-2">
      <Label htmlFor={nome}>{rotulo}</Label>
      <textarea id={nome} name={nome} defaultValue={valor ?? ''} className={classeTextarea} />
    </div>
  );
}

/** Trava de margem/desconto: ADMIN libera direto; no aparelho do vendedor, o ADMIN digita e-mail e senha. */
function Liberacao({ motivos, admin, salvando, onLiberar }: { motivos: string[]; admin: boolean; salvando: boolean; onLiberar: (corpo: object) => void }) {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  return (
    <div className="mt-3 space-y-2 rounded-md border border-red-500/40 bg-red-500/5 p-3">
      <p className="font-medium">Precisa da liberação do administrador para enviar a proposta</p>
      <ul className="list-disc pl-5 text-xs">{motivos.map((m) => <li key={m}>{m}</li>)}</ul>
      {admin ? (
        <Button size="sm" disabled={salvando} onClick={() => onLiberar({})}>Liberar (sou administrador)</Button>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Input className="w-56" type="email" placeholder="E-mail do administrador" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          <Input className="w-40" type="password" placeholder="Senha" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="new-password" />
          <Button size="sm" disabled={salvando || !email || !senha} onClick={() => { onLiberar({ email, senha }); setSenha(''); }}>Liberar</Button>
        </div>
      )}
    </div>
  );
}

/**
 * Teto de desconto (Gabriel, 27/11/2026): o vendedor vê até onde pode negociar sem sair da margem
 * saudável. Só nesta tela: não vai no PDF, no link do cliente nem no WhatsApp.
 */
function TetoNegociacao({ teto, desatualizado }: { teto: NonNullable<Orcamento['teto']>; desatualizado: boolean }) {
  const passouMinimo = Number(teto.descontoAtual) > Number(teto.senhaAcima.valor);
  const faixaAmarela = Number(teto.senhaAcima.valor) > Number(teto.maximo.valor);
  return (
    <Card className="border-sky-500/40">
      <CardHeader>
        <CardTitle>Negociação</CardTitle>
        <p className="text-xs text-muted-foreground">Só para você. Não aparece para o cliente (PDF, link e WhatsApp).</p>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="rounded-md bg-sky-500/10 px-3 py-2">
          <div className="text-xs text-muted-foreground">Desconto máximo nesta venda</div>
          <div className="text-lg font-semibold">{moeda(teto.maximo.valor)} <span className="text-sm font-normal">({pct(teto.maximo.pct)})</span></div>
          <div className="text-xs text-muted-foreground">
            {teto.maximo.pelo === 'VENDEDOR'
              ? `É o seu limite de desconto (${pct(teto.vendedorPct ?? undefined)}).`
              : `Mantém a margem saudável (${teto.saudavel.margemPct}% ou mais).`}
          </div>
        </div>
        {Number(teto.descontoAtual) > 0 && (
          teto.passou
            ? <p className={passouMinimo ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}>
                O desconto dado ({moeda(teto.descontoAtual)}) passou do máximo.{passouMinimo ? ' Precisa da senha do administrador.' : ' A margem saiu da faixa saudável.'}
              </p>
            : <p>Já deu {moeda(teto.descontoAtual)} de desconto. Ainda cabe <strong>{moeda(teto.aindaCabe)}</strong>.</p>
        )}
        <p className="text-xs text-muted-foreground">
          {faixaAmarela
            ? `De ${moeda(teto.maximo.valor)} até ${moeda(teto.senhaAcima.valor)} (${pct(teto.senhaAcima.pct)}) a margem fica amarela, abaixo do saudável. Acima disso precisa da senha do administrador.`
            : 'Acima disso precisa da senha do administrador.'}
        </p>
        {desatualizado && <p className="text-xs text-muted-foreground">Calculado na última sincronização: confere de novo quando a internet voltar.</p>}
      </CardContent>
    </Card>
  );
}
