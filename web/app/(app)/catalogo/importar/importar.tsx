'use client';
import { ALTERACAO_EM_MASSA } from '@sistema/motor-calculo/navegador';
import { ConfirmarAlteracao } from '@/components/confirmar-alteracao';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Mensagens } from '@/components/cadastro/campos';
import { api } from '@/lib/cliente';

type Acao = 'CRIAR' | 'ATUALIZAR' | 'SEM_MUDANCA' | 'IGNORADA' | 'ERRO';
type Item = {
  aba: string; linha: number; tipo: 'PRODUTO' | 'BARRA'; sku: string; nome: string | null; tamanhoM: number | null;
  acao: Acao; mudancas: string[]; erros: string[]; avisos: string[];
};
type Resumo = { criar: number; atualizar: number; semMudanca: number; ignoradas: number; erros: number };
type Previa = { arquivo: string; itens: Item[]; resumo: Resumo };
type Importacao = {
  id: string; arquivo: string; criadoEm: string; criadoPor: string | null; resumo: Resumo; alteracoes: number;
  desfeitaEm: string | null; desfeitaPor: string | null;
};

const ROTULO: Record<Acao, { texto: string; classe: string }> = {
  CRIAR: { texto: 'novo', classe: 'border-primary/40 bg-primary/10 text-primary' },
  ATUALIZAR: { texto: 'atualiza', classe: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  SEM_MUDANCA: { texto: 'sem mudança', classe: 'text-muted-foreground' },
  IGNORADA: { texto: 'ignorada', classe: 'text-muted-foreground' },
  ERRO: { texto: 'erro', classe: 'border-destructive/40 bg-destructive/10 text-destructive' },
};

const dataHora = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
const LIMITE_MB = 8;

function lerBase64(f: File): Promise<string> {
  return new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => falha(new Error('Não foi possível ler o arquivo.'));
    r.readAsDataURL(f);
  });
}

/**
 * Importar tabela de preços (só ADMIN): baixa a planilha, preenche no Excel,
 * envia, confere a prévia e aplica. Cada importação pode ser desfeita.
 */
export function ImportarPrecos() {
  const [arquivo, setArquivo] = useState<{ nome: string; conteudo: string } | null>(null);
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [soAlteracoes, setSoAlteracoes] = useState(true);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [historico, setHistorico] = useState<Importacao[] | null>(null);
  const [confirmarDesfazer, setConfirmarDesfazer] = useState<string | null>(null);
  /** Caixinha ALTERAR (mais de 10 alterações): aplicar a planilha ou desfazer uma importação. */
  const [pedirAlterar, setPedirAlterar] = useState<{ tipo: 'aplicar' } | { tipo: 'desfazer'; id: string; n: number } | null>(null);

  const carregarHistorico = useCallback(() => {
    api<{ importacoes: Importacao[] }>('/api/catalogo/importacoes').then((r) => setHistorico(r.importacoes)).catch(() => setHistorico([]));
  }, []);
  useEffect(carregarHistorico, [carregarHistorico]);

  async function escolher(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    setErro(null); setOk(null); setPrevia(null); setArquivo(null);
    if (!f) return;
    if (f.size > LIMITE_MB * 1024 * 1024) { setErro(`Arquivo grande demais (máximo ${LIMITE_MB} MB).`); return; }
    setCarregando(true);
    try {
      const a = { nome: f.name, conteudo: await lerBase64(f) };
      const p = await api<Previa>('/api/catalogo/importacao/previa', { method: 'POST', corpo: { arquivo: a.nome, conteudo: a.conteudo } });
      setArquivo(a); setPrevia(p);
    } catch (e) { setErro((e as Error).message); } finally { setCarregando(false); }
  }

  async function aplicar(confirmacao?: string) {
    if (!arquivo) return;
    if (!confirmacao && aplicaveis > ALTERACAO_EM_MASSA.limite) { setPedirAlterar({ tipo: 'aplicar' }); return; }
    setErro(null); setOk(null); setCarregando(true);
    try {
      const r = await api<{ previa: Previa }>('/api/catalogo/importacao/aplicar', { method: 'POST', corpo: { arquivo: arquivo.nome, conteudo: arquivo.conteudo, confirmacao } });
      setPedirAlterar(null);
      const { criar, atualizar, erros } = r.previa.resumo;
      setOk(`Pronto! ${criar} item(ns) novo(s) e ${atualizar} atualizado(s).${erros ? ` ${erros} linha(s) com erro ficaram de fora.` : ''} Se precisar, dá para desfazer logo abaixo.`);
      setPrevia(null); setArquivo(null);
      carregarHistorico();
    } catch (e) { setErro((e as Error).message); } finally { setCarregando(false); }
  }

  async function desfazer(id: string, n: number, confirmacao?: string) {
    if (!confirmacao && n > ALTERACAO_EM_MASSA.limite) { setConfirmarDesfazer(null); setPedirAlterar({ tipo: 'desfazer', id, n }); return; }
    setErro(null); setOk(null); setConfirmarDesfazer(null); setCarregando(true);
    try {
      const r = await api<{ restaurados: number; mantidos: string[] }>(`/api/catalogo/importacoes/${id}/desfazer`, { method: 'POST', corpo: { confirmacao } });
      setPedirAlterar(null);
      setOk(`Importação desfeita: ${r.restaurados} item(ns) voltaram ao preço anterior.${r.mantidos.length
        ? ` Mantidos (foram alterados depois da importação): ${r.mantidos.join('; ')}.` : ''}`);
      carregarHistorico();
    } catch (e) { setErro((e as Error).message); } finally { setCarregando(false); }
  }

  const aplicaveis = previa ? previa.resumo.criar + previa.resumo.atualizar : 0;
  const itens = previa?.itens.filter((i) => !soAlteracoes || i.acao === 'CRIAR' || i.acao === 'ATUALIZAR' || i.acao === 'ERRO' || i.avisos.length) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Importar tabela de preços</h1>
        <Button asChild variant="ghost"><Link href="/catalogo">Voltar ao catálogo</Link></Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Baixe a planilha</CardTitle>
          <CardDescription>
            Ela já vem com todos os produtos e preços atuais, as linhas dos serviços de instalação (SRV) e demais códigos
            que o orçamento usa, e a tabela de barras de cada trilho (1 a 6 m). Altere no Excel o que precisar e salve.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline"><a href="/api/catalogo/importacao/planilha">Baixar planilha de preços (.xlsx)</a></Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Envie a planilha preenchida</CardTitle>
          <CardDescription>
            Aceita Excel (.xlsx) ou .csv. Nada é gravado agora: primeiro você confere o que vai mudar.
            Célula vazia mantém o valor atual e nenhum produto é apagado.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="inline-flex w-fit cursor-pointer items-center rounded-md border bg-card px-4 py-2 text-sm font-medium hover:bg-muted">
            {carregando ? 'Lendo…' : 'Escolher arquivo'}
            <input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" className="sr-only" onChange={escolher} disabled={carregando} />
          </label>
          <Mensagens erro={erro} ok={ok} />
        </CardContent>
      </Card>

      {previa && (
        <Card>
          <CardHeader>
            <CardTitle>3. Confira e aplique</CardTitle>
            <CardDescription>Arquivo: {previa.arquivo}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge className={ROTULO.CRIAR.classe}>{previa.resumo.criar} novo(s)</Badge>
              <Badge className={ROTULO.ATUALIZAR.classe}>{previa.resumo.atualizar} atualização(ões)</Badge>
              <Badge className={ROTULO.SEM_MUDANCA.classe}>{previa.resumo.semMudanca} sem mudança</Badge>
              {previa.resumo.ignoradas > 0 && <Badge className={ROTULO.IGNORADA.classe}>{previa.resumo.ignoradas} ignorada(s)</Badge>}
              {previa.resumo.erros > 0 && <Badge className={ROTULO.ERRO.classe}>{previa.resumo.erros} com erro</Badge>}
            </div>
            {previa.resumo.erros > 0 && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                As linhas com erro <strong>não serão importadas</strong>. Você pode aplicar o resto agora e corrigir essas
                linhas depois, ou corrigir a planilha e enviar de novo.
              </p>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={soAlteracoes} onChange={(e) => setSoAlteracoes(e.target.checked)} />
              mostrar só o que muda, avisos e erros
            </label>
            {itens.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma linha para mostrar.</p> : (
              <div className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full text-sm">
                  <thead className="bg-muted text-left">
                    <tr>
                      <th className="px-3 py-2">Linha</th>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2">Situação</th>
                      <th className="px-3 py-2">O que acontece</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itens.map((i) => (
                      <tr key={`${i.aba}-${i.linha}`} className="border-t align-top">
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{i.aba}<br />linha {i.linha}</td>
                        <td className="px-3 py-2">
                          <span className="font-mono text-xs">{i.sku || '—'}</span>
                          {i.tamanhoM && <span className="text-xs"> · barra {i.tamanhoM} m</span>}
                          {i.nome && <div className="text-xs text-muted-foreground">{i.nome}</div>}
                        </td>
                        <td className="px-3 py-2"><Badge className={ROTULO[i.acao].classe}>{ROTULO[i.acao].texto}</Badge></td>
                        <td className="px-3 py-2">
                          {i.mudancas.map((m) => <div key={m}>{m}</div>)}
                          {i.erros.map((m) => <div key={m} className="text-destructive">{m}</div>)}
                          {i.avisos.map((m) => <div key={m} className="text-amber-700 dark:text-amber-300">{m}</div>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => aplicar()} disabled={carregando || aplicaveis === 0}>
                {carregando ? 'Aplicando…' : aplicaveis === 0 ? 'Nada para aplicar' : `Aplicar ${aplicaveis} alteração(ões)`}
              </Button>
              <Button variant="ghost" onClick={() => { setPrevia(null); setArquivo(null); }} disabled={carregando}>Cancelar</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Importações anteriores</CardTitle>
          <CardDescription>
            Desfazer volta os preços de antes. Produto criado pela importação fica inativo (não é apagado). Item alterado
            depois da importação é mantido como está.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {historico === null ? <p className="text-sm text-muted-foreground">Carregando…</p> : historico.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma importação ainda.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {historico.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div>
                    <div className="font-medium">{h.arquivo}</div>
                    <div className="text-xs text-muted-foreground">
                      {dataHora.format(new Date(h.criadoEm))}{h.criadoPor ? ` · ${h.criadoPor}` : ''} · {h.alteracoes} alteração(ões)
                      {h.desfeitaEm && ` · desfeita em ${dataHora.format(new Date(h.desfeitaEm))}${h.desfeitaPor ? ` por ${h.desfeitaPor}` : ''}`}
                    </div>
                  </div>
                  {!h.desfeitaEm && (confirmarDesfazer === h.id ? (
                    <div className="flex gap-2">
                      <Button size="sm" variant="destructive" onClick={() => desfazer(h.id, h.alteracoes)} disabled={carregando}>Confirmar desfazer</Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmarDesfazer(null)}>Não</Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setConfirmarDesfazer(h.id)} disabled={carregando}>Desfazer</Button>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {pedirAlterar && previa && pedirAlterar.tipo === 'aplicar' && (
        <ConfirmarAlteracao titulo={`Aplicar ${aplicaveis} alterações de preço?`} ocupado={carregando}
          aoCancelar={() => setPedirAlterar(null)} aoContinuar={(p) => aplicar(p)}>
          <p className="text-sm">
            {previa.resumo.criar} item(ns) novo(s) e {previa.resumo.atualizar} atualizado(s). Confira a prévia abaixo antes de continuar.
            {previa.resumo.erros > 0 && ` ${previa.resumo.erros} linha(s) com erro ficam de fora.`}
          </p>
        </ConfirmarAlteracao>
      )}
      {pedirAlterar && pedirAlterar.tipo === 'desfazer' && (
        <ConfirmarAlteracao titulo={`Desfazer ${pedirAlterar.n} alterações?`} ocupado={carregando}
          aoCancelar={() => setPedirAlterar(null)} aoContinuar={(p) => desfazer(pedirAlterar.id, pedirAlterar.n, p)}>
          <p className="text-sm">Os preços voltam ao que eram antes desta importação.</p>
        </ConfirmarAlteracao>
      )}
    </div>
  );
}
