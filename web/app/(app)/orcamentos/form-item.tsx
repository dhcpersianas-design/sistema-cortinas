'use client';
import { Fragment, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { classeSelect } from '@/components/cadastro/campos';
import { regrasDoModelo, textoDisponibilidade } from '@sistema/motor-calculo/navegador';
import type { Item, ProdutoCatalogo } from '@/lib/orcamentos-offline';

/**
 * Cadastro de um vão (item) do orçamento: cortina ou persiana.
 * Medidas em METROS ou CENTÍMETROS, sempre explícito (12.5), com conferência de
 * valores fora do normal (largura > 15 m ou altura > 10 m = provável erro de 100x).
 */

type Unidade = 'm' | 'cm';
const LIM = { largura: 15, altura: 10 };

function paraMetros(v: string, u: Unidade): string | null {
  const t = v.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = u === 'cm' ? Number(t) / 100 : Number(t);
  return n > 0 ? n.toFixed(u === 'cm' ? 2 : Math.min(4, (t.split('.')[1] ?? '').length || 2)) : null;
}
function inteiro(v: string, rotulo: string): number {
  if (v === '') return 0;
  if (!/^\d{1,2}$/.test(v)) throw new Error(`${rotulo}: use um número inteiro (0, 1, 2…).`);
  return Number(v);
}
const deMetros = (v: unknown, u: Unidade) => (v == null || v === '' ? '' : u === 'cm' ? String(Math.round(Number(v) * 100)) : String(v).replace('.', ','));

type Props = {
  produtos: ProdutoCatalogo[];
  ambientes: string[];
  inicial?: Item;
  ambienteSugerido?: string;
  /** Já existe controle remoto em outra persiana motorizada deste ambiente? */
  temControleNoOrcamento: (ignorarId?: string) => boolean;
  onSalvar: (i: Item) => void;
  onCancelar: () => void;
};

export function FormItem({ produtos, ambientes, inicial, ambienteSugerido, temControleNoOrcamento, onSalvar, onCancelar }: Props) {
  const e = (inicial?.entrada ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const [tipo, setTipo] = useState<'CORTINA' | 'PERSIANA'>(inicial?.tipo ?? 'CORTINA');
  const [confeccao, setConfeccao] = useState<string>(e.confeccao ?? 'WAVE');
  const [unidade, setUnidade] = useState<Unidade>('m');
  const [erro, setErro] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState<string | null>(null);
  // Modelo escolhido agora (para o quadro de regras). Os selects são livres; o form avisa quando mudam.
  const [escolha, setEscolha] = useState<Record<string, string>>(() => ({
    persiana: e.sku ?? '', tecido: e.tecido?.sku ?? '', forro: e.forro?.sku ?? '', trilho: e.skus?.trilho ?? '', acionamento: e.acionamento ?? 'MANUAL',
  }));
  function aoMudar(ev: React.FormEvent<HTMLFormElement>) {
    const t = ev.target as HTMLSelectElement;
    if (['persiana', 'tecido', 'forro', 'trilho', 'acionamento'].includes(t.name)) setEscolha((x) => ({ ...x, [t.name]: t.value }));
  }

  const porCategoria = useMemo(() => {
    // Pelo tipo da categoria (perfil); cache antigo sem perfil cai no nome da categoria.
    // Fora de linha some da lista, a não ser que já esteja escolhido neste item (aí aparece com o aviso).
    const atuais = new Set([e.sku, e.tecido?.sku, e.forro?.sku, ...Object.values(e.skus ?? {})].filter(Boolean) as string[]);
    const m = (perfil: string, re: RegExp) => produtos.filter((p) => (p.perfil ? p.perfil === perfil : re.test(p.categoria))
      && (p.disponibilidade !== 'FORA_DE_LINHA' || atuais.has(p.sku)));
    return {
      tecidos: m('TECIDO', /^tecido/i).filter((p) => !p.metadata?.eh_forro),
      forros: m('TECIDO', /^tecido/i).filter((p) => Boolean(p.metadata?.eh_forro)),
      trilhos: m('TRILHO', /^trilho/i),
      persianas: m('PERSIANA', /^persiana/i),
      maoObra: m('CONFECCAO', /^m[aã]o de obra/i),
      controles: produtos.filter((p) => Number(p.metadata?.canais) > 0).sort((a, b) => Number(a.metadata.canais) - Number(b.metadata.canais)),
    };
  }, [produtos]);

  const regras = useMemo(() => {
    const obter = (sku: string) => produtos.find((p) => p.sku === sku);
    // Sem escolha ainda: vale a primeira opção da lista (é a que aparece selecionada).
    const ou = (v: string | undefined, lista: ProdutoCatalogo[]) => v || lista[0]?.sku;
    return regrasDoModelo(tipo === 'PERSIANA'
      ? { tipo, persiana: ou(escolha.persiana, porCategoria.persianas), acionamento: escolha.acionamento }
      : { tipo, confeccao, tecido: ou(escolha.tecido, porCategoria.tecidos), forro: escolha.forro || undefined, trilho: ou(escolha.trilho, porCategoria.trilhos) }, obter)
      .concat(disponibilidadeEscolhida(tipo === 'PERSIANA'
        ? [ou(escolha.persiana, porCategoria.persianas)]
        : [ou(escolha.tecido, porCategoria.tecidos), escolha.forro, ou(escolha.trilho, porCategoria.trilhos)], obter));
  }, [tipo, confeccao, escolha, produtos, porCategoria]);

  function salvar(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setErro(null);
    const f = new FormData(ev.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const ambiente = s('ambiente');
    if (!ambiente) { setErro('Informe o ambiente (ex.: Sala).'); return; }
    const medida = (k: string, rotulo: string, lim: number) => {
      const v = paraMetros(s(k), unidade);
      if (!v) throw new Error(`${rotulo}: informe um número em ${unidade === 'm' ? 'metros (ex.: 2,60)' : 'centímetros (ex.: 260)'}.`);
      if (Number(v) > lim && confirmar !== k) {
        setConfirmar(k);
        throw new Error(`${rotulo} de ${v.replace('.', ',')} m parece grande demais. Confira se não digitou em centímetros. Toque em salvar de novo para confirmar.`);
      }
      return v;
    };
    try {
      let entrada: Record<string, unknown>;
      if (tipo === 'CORTINA') {
        const forro = s('forro');
        entrada = {
          larguraTrilho: medida('largura', 'Largura do trilho', LIM.largura),
          alturaPronta: medida('altura', 'Altura pronta', LIM.altura),
          numFolhas: Number(s('numFolhas')) as 1 | 2,
          confeccao: s('confeccao'),
          // Fator em branco = padrão do motor (wave 2,8; prega macho 3,0; franzido 2,5; forro 1,8).
          tecido: { sku: s('tecido'), ...(s('fator') ? { fator: s('fator').replace(',', '.') } : {}) },
          ...(forro ? { forro: { sku: forro, ...(s('fatorForro') ? { fator: s('fatorForro').replace(',', '.') } : {}) } } : {}),
          skus: { trilho: s('trilho'), ...(s('maoObra') ? { maoObraTecido: s('maoObra') } : {}) },
        };
      } else {
        const modo = s('modoMedida');
        const larg = medida('largura', 'Largura', LIM.largura);
        const alt = medida('altura', 'Altura', LIM.altura);
        const motor = s('acionamento') === 'MOTORIZADO';
        entrada = {
          sku: s('persiana'),
          medida: modo === 'PRODUCAO' ? { tipo: 'PRODUCAO', largura: larg, altura: alt } : { tipo: 'VAO_BRUTO', modo, largura: larg, altura: alt },
          acionamento: s('acionamento'), ladoComando: s('ladoComando'), sentidoEnrolamento: s('sentidoEnrolamento'),
          possuiBando: f.get('possuiBando') === 'on', possuiGuiaLateral: f.get('possuiGuiaLateral') === 'on',
          ...(motor ? {
            qtdControles: s('controle') ? 1 : 0, qtdHubs: inteiro(s('qtdHubs'), 'Hub Wi-Fi'),
            ...(s('controle') ? { skus: { controle: s('controle') } } : {}),
          } : {}),
        };
      }
      const mudouEntrada = JSON.stringify(entrada) !== JSON.stringify(inicial?.entrada);
      onSalvar({
        id: inicial?.id ?? crypto.randomUUID(),
        ambiente, tipo, entrada,
        // Mudou a medida/opção: a descrição volta a ser gerada; os ajustes manuais continuam.
        descricaoComercial: mudouEntrada ? '' : (s('descricaoComercial') || inicial?.descricaoComercial || ''),
        ajustes: inicial?.tipo === tipo ? inicial.ajustes : [],
      });
    } catch (err) { setErro((err as Error).message); }
  }

  const medidaRotulo = unidade === 'm' ? 'm' : 'cm';
  const ambienteInicial = inicial?.ambiente ?? ambienteSugerido ?? '';
  // Cada canal aciona 1 peça. Padrão: o menor controle, só na primeira persiana motorizada do ambiente;
  // com várias, o configurador sugere um controle com canais para todas (botão no ambiente).
  const controlePadrao = inicial?.tipo === 'PERSIANA' && e.acionamento === 'MOTORIZADO'
    ? ((e.qtdControles ?? 1) > 0 ? (e.skus?.controle ?? 'MOT-002') : '')
    : (temControleNoOrcamento(inicial?.id) ? '' : (porCategoria.controles[0]?.sku ?? ''));

  return (
    <form onSubmit={salvar} onChange={aoMudar} className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ambiente">Ambiente</Label>
        <Input id="ambiente" name="ambiente" list="lista-ambientes" defaultValue={ambienteInicial} placeholder="Sala, Quarto casal…" required />
        <datalist id="lista-ambientes">{ambientes.map((a) => <option key={a} value={a} />)}</datalist>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Tipo</Label>
        <div className="flex gap-2">
          {(['CORTINA', 'PERSIANA'] as const).map((t) => (
            <Button key={t} type="button" variant={tipo === t ? 'default' : 'outline'} className="flex-1" onClick={() => setTipo(t)}>
              {t === 'CORTINA' ? 'Cortina' : 'Persiana'}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label>Medidas em</Label>
        <div className="flex gap-2">
          {(['m', 'cm'] as const).map((u) => (
            <Button key={u} type="button" size="sm" variant={unidade === u ? 'default' : 'outline'} onClick={() => setUnidade(u)}>
              {u === 'm' ? 'Metros (2,60)' : 'Centímetros (260)'}
            </Button>
          ))}
        </div>
      </div>

      {/* key por tipo: trocar cortina/persiana não reaproveita os campos do outro tipo */}
      <Fragment key={tipo}>
      {tipo === 'CORTINA' ? (
        <>
          <CampoMedida nome="largura" rotulo={`Largura do trilho (${medidaRotulo})`} valor={deMetros(e.larguraTrilho, unidade)} key={`l${unidade}`} />
          <CampoMedida nome="altura" rotulo={`Altura pronta (${medidaRotulo})`} valor={deMetros(e.alturaPronta, unidade)} key={`a${unidade}`} dica="Já descontado 1 a 2 cm do piso" />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confeccao">Confecção</Label>
            <select id="confeccao" name="confeccao" value={confeccao} onChange={(ev) => setConfeccao(ev.target.value)} className={classeSelect}>
              <option value="WAVE">Wave</option><option value="PREGA">Prega macho</option><option value="FRANZIDO">Franzido</option>
            </select>
          </div>
          <Selecao nome="numFolhas" rotulo="Folhas" valor={String(e.numFolhas ?? 2)} opcoes={[['2', '2 folhas'], ['1', '1 folha']]} />
          <Selecao nome="tecido" rotulo="Tecido" valor={e.tecido?.sku} opcoes={porCategoria.tecidos.map((p) => [p.sku, `${p.nome} (${p.sku})${sufixoStatus(p)}`])} />
          <CampoTexto nome="fator" rotulo="Fator de franzimento" valor={e.tecido?.fator ? String(e.tecido.fator).replace('.', ',') : ''}
            dica={`Em branco: ${{ WAVE: '2,8', PREGA: '3,0', FRANZIDO: '2,5' }[confeccao] ?? ''} (padrão da loja)`} />
          <Selecao nome="forro" rotulo="Forro" valor={e.forro?.sku ?? ''} opcoes={[['', 'Sem forro'], ...porCategoria.forros.map((p) => [p.sku, `${p.nome} (${p.sku})${sufixoStatus(p)}`] as [string, string])]} />
          <CampoTexto nome="fatorForro" rotulo="Fator do forro" valor={e.forro?.fator ? String(e.forro.fator).replace('.', ',') : ''} dica="Em branco: 1,8 (padrão da loja)" />
          {porCategoria.maoObra.length > 0 && (
            <Selecao key={`mdo-${confeccao}`} nome="maoObra" rotulo="Mão de obra da confecção" largo
              valor={e.skus?.maoObraTecido && e.confeccao === confeccao ? e.skus.maoObraTecido : (confeccao === 'WAVE' ? 'MDO-001' : porCategoria.maoObra.find((p) => /prega/i.test(p.nome))?.sku)}
              opcoes={porCategoria.maoObra.map((p) => [p.sku, `${p.nome} (${p.sku})${sufixoStatus(p)}`])} />
          )}
          <Selecao nome="trilho" rotulo="Trilho / varão" valor={e.skus?.trilho} opcoes={porCategoria.trilhos.map((p) => [p.sku, `${p.nome} (${p.sku})${p.tabelaBarrasCompleta ? ' · por barra' : ''}${sufixoStatus(p)}`])} largo />
        </>
      ) : (
        <>
          <Selecao nome="persiana" rotulo="Persiana" valor={e.sku} opcoes={porCategoria.persianas.map((p) => [p.sku, `${p.nome} (${p.sku})${sufixoStatus(p)}`])} largo />
          <Selecao nome="modoMedida" rotulo="A medida é" valor={e.medida?.tipo === 'VAO_BRUTO' ? e.medida.modo : 'PRODUCAO'} largo
            opcoes={[['PRODUCAO', 'Medida final da persiana'], ['DENTRO_VAO', 'Vão bruto, instalação dentro do vão'], ['FORA_VAO', 'Vão bruto, instalação fora do vão'], ['TETO', 'Vão bruto, instalação no teto']]} />
          <CampoMedida nome="largura" rotulo={`Largura (${medidaRotulo})`} valor={deMetros(Array.isArray(e.medida?.largura) ? e.medida.largura[0] : e.medida?.largura, unidade)} key={`pl${unidade}`} />
          <CampoMedida nome="altura" rotulo={`Altura (${medidaRotulo})`} valor={deMetros(Array.isArray(e.medida?.altura) ? e.medida.altura[0] : e.medida?.altura, unidade)} key={`pa${unidade}`} />
          <Selecao nome="acionamento" rotulo="Acionamento" valor={e.acionamento ?? 'MANUAL'} opcoes={[['MANUAL', 'Manual'], ['MOTORIZADO', 'Motorizado']]} />
          <Selecao nome="ladoComando" rotulo="Lado do comando" valor={e.ladoComando ?? 'DIREITO'} opcoes={[['DIREITO', 'Direito'], ['ESQUERDO', 'Esquerdo']]} />
          <Selecao nome="sentidoEnrolamento" rotulo="Enrolamento" valor={e.sentidoEnrolamento ?? 'NORMAL'} opcoes={[['NORMAL', 'Normal'], ['REVERSO', 'Reverso']]} />
          <Selecao nome="controle" rotulo="Controle remoto (se motorizada)" valor={controlePadrao}
            opcoes={[['', 'Sem controle neste item (usa o de outra persiana)'], ...porCategoria.controles.map((p) => [p.sku, `${p.nome} (${p.metadata.canais} canal/is)`] as [string, string])]} />
          <CampoTexto nome="qtdHubs" rotulo="Hub Wi-Fi (se motorizada)" valor={String(e.qtdHubs ?? 0)} />
          <div className="flex flex-wrap gap-4 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="possuiBando" defaultChecked={Boolean(e.possuiBando)} /> Bandô</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="possuiGuiaLateral" defaultChecked={Boolean(e.possuiGuiaLateral)} /> Guia lateral</label>
          </div>
        </>
      )}
      </Fragment>

      {regras.length > 0 && <QuadroRegras regras={regras} />}

      {inicial && (
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="descricaoComercial">Descrição na proposta</Label>
          <Input id="descricaoComercial" name="descricaoComercial" defaultValue={inicial.descricaoComercial} />
          <span className="text-xs text-muted-foreground">Mudando medida ou opção, a descrição é gerada de novo.</span>
        </div>
      )}

      {erro && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:col-span-2">{erro}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit">{inicial ? 'Salvar item' : 'Incluir item'}</Button>
        <Button type="button" variant="ghost" onClick={onCancelar}>Cancelar</Button>
      </div>
    </form>
  );
}

function CampoMedida({ nome, rotulo, valor, dica }: { nome: string; rotulo: string; valor: string; dica?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={nome}>{rotulo}</Label>
      <Input id={nome} name={nome} inputMode="decimal" defaultValue={valor} required autoComplete="off" />
      {dica && <span className="text-xs text-muted-foreground">{dica}</span>}
    </div>
  );
}

function CampoTexto({ nome, rotulo, valor, dica }: { nome: string; rotulo: string; valor: string; dica?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={nome}>{rotulo}</Label>
      <Input id={nome} name={nome} inputMode="decimal" defaultValue={valor} autoComplete="off" />
      {dica && <span className="text-xs text-muted-foreground">{dica}</span>}
    </div>
  );
}

/** " · EM FALTA, previsão 10/12/2026" na lista de escolha (só o vendedor vê). */
function sufixoStatus(p: ProdutoCatalogo): string {
  if (!p.disponibilidade || p.disponibilidade === 'DISPONIVEL') return '';
  return ` · ${textoDisponibilidade(p.disponibilidade, p.previsaoDisponivel).toUpperCase()}`;
}

/** Linhas do quadro de atenção para produto escolhido que não está disponível. */
function disponibilidadeEscolhida(skus: (string | undefined)[], obter: (sku: string) => ProdutoCatalogo | undefined) {
  const r: { titulo: string; texto: string }[] = [];
  for (const sku of skus) {
    const p = sku ? obter(sku) : undefined;
    if (!p || !p.disponibilidade || p.disponibilidade === 'DISPONIVEL') continue;
    const extra = p.disponibilidade === 'FORA_DE_LINHA' ? ' Troque o produto: o orçamento não pode ser enviado com ele.'
      : p.disponibilidade === 'SOB_CONSULTA' ? ' Preço não é automático: confirme com o fornecedor; só o administrador envia.'
      : ' Confirme o prazo com o fornecedor.';
    r.push({ titulo: p.nome, texto: `${textoDisponibilidade(p.disponibilidade, p.previsaoDisponivel)}.${extra}` });
  }
  return r;
}

function Selecao({ nome, rotulo, valor, opcoes, largo }: { nome: string; rotulo: string; valor?: string; opcoes: [string, string][]; largo?: boolean }) {
  return (
    <div className={`flex flex-col gap-1.5 ${largo ? 'sm:col-span-2' : ''}`}>
      <Label htmlFor={nome}>{rotulo}</Label>
      <select id={nome} name={nome} defaultValue={valor ?? opcoes[0]?.[0]} className={classeSelect}>
        {opcoes.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </div>
  );
}

/** Quadro de atenção com as regras do modelo escolhido. Só para o vendedor: não vai para o PDF. */
export function QuadroRegras({ regras }: { regras: { titulo: string; texto: string }[] }) {
  return (
    <div role="note" className="rounded-md border border-amber-500/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100 sm:col-span-2">
      <p className="font-semibold">⚠ Atenção: regras deste modelo</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {regras.map((r) => <li key={r.titulo}><span className="font-medium">{r.titulo}:</span> {r.texto}</li>)}
      </ul>
      <p className="mt-1 text-xs opacity-80">Só para você. O cliente não vê isto na proposta.</p>
    </div>
  );
}
