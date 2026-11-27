'use client';
import { Fragment, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { classeSelect } from '@/components/cadastro/campos';
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
  temControleNoAmbiente: (ambiente: string, ignorarId?: string) => boolean;
  onSalvar: (i: Item) => void;
  onCancelar: () => void;
};

export function FormItem({ produtos, ambientes, inicial, ambienteSugerido, temControleNoAmbiente, onSalvar, onCancelar }: Props) {
  const e = (inicial?.entrada ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const [tipo, setTipo] = useState<'CORTINA' | 'PERSIANA'>(inicial?.tipo ?? 'CORTINA');
  const [unidade, setUnidade] = useState<Unidade>('m');
  const [erro, setErro] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState<string | null>(null);

  const porCategoria = useMemo(() => {
    const m = (re: RegExp) => produtos.filter((p) => re.test(p.categoria));
    return {
      tecidos: m(/^tecido/i).filter((p) => !p.metadata?.eh_forro),
      forros: m(/^tecido/i).filter((p) => Boolean(p.metadata?.eh_forro)),
      trilhos: m(/^trilho/i),
      persianas: m(/^persiana/i),
    };
  }, [produtos]);

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
          tecido: { sku: s('tecido'), fator: s('fator').replace(',', '.') || '2.5' },
          ...(forro ? { forro: { sku: forro, fator: s('fatorForro').replace(',', '.') || '2.0' } } : {}),
          skus: { trilho: s('trilho') },
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
          ...(motor ? { qtdControles: inteiro(s('qtdControles'), 'Controles remotos'), qtdHubs: inteiro(s('qtdHubs'), 'Hub Wi-Fi') } : {}),
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
  const controlePadrao = (inicial && e.qtdControles != null) ? e.qtdControles : (temControleNoAmbiente(ambienteInicial, inicial?.id) ? 0 : 1);

  return (
    <form onSubmit={salvar} className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2">
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
          <Selecao nome="confeccao" rotulo="Confecção" valor={e.confeccao ?? 'WAVE'} opcoes={[['WAVE', 'Wave'], ['PREGA', 'Prega']]} />
          <Selecao nome="numFolhas" rotulo="Folhas" valor={String(e.numFolhas ?? 2)} opcoes={[['2', '2 folhas'], ['1', '1 folha']]} />
          <Selecao nome="tecido" rotulo="Tecido" valor={e.tecido?.sku} opcoes={porCategoria.tecidos.map((p) => [p.sku, `${p.nome} (${p.sku})`])} />
          <CampoTexto nome="fator" rotulo="Fator de franzimento" valor={String(e.tecido?.fator ?? '2.5').replace('.', ',')} dica="Wave costuma usar 2,5" />
          <Selecao nome="forro" rotulo="Forro" valor={e.forro?.sku ?? ''} opcoes={[['', 'Sem forro'], ...porCategoria.forros.map((p) => [p.sku, `${p.nome} (${p.sku})`] as [string, string])]} />
          <CampoTexto nome="fatorForro" rotulo="Fator do forro" valor={String(e.forro?.fator ?? '2.0').replace('.', ',')} />
          <Selecao nome="trilho" rotulo="Trilho / varão" valor={e.skus?.trilho} opcoes={porCategoria.trilhos.map((p) => [p.sku, `${p.nome} (${p.sku})${p.tabelaBarrasCompleta ? ' · por barra' : ''}`])} largo />
        </>
      ) : (
        <>
          <Selecao nome="persiana" rotulo="Persiana" valor={e.sku} opcoes={porCategoria.persianas.map((p) => [p.sku, `${p.nome} (${p.sku})`])} largo />
          <Selecao nome="modoMedida" rotulo="A medida é" valor={e.medida?.tipo === 'VAO_BRUTO' ? e.medida.modo : 'PRODUCAO'} largo
            opcoes={[['PRODUCAO', 'Medida final da persiana'], ['DENTRO_VAO', 'Vão bruto, instalação dentro do vão'], ['FORA_VAO', 'Vão bruto, instalação fora do vão'], ['TETO', 'Vão bruto, instalação no teto']]} />
          <CampoMedida nome="largura" rotulo={`Largura (${medidaRotulo})`} valor={deMetros(Array.isArray(e.medida?.largura) ? e.medida.largura[0] : e.medida?.largura, unidade)} key={`pl${unidade}`} />
          <CampoMedida nome="altura" rotulo={`Altura (${medidaRotulo})`} valor={deMetros(Array.isArray(e.medida?.altura) ? e.medida.altura[0] : e.medida?.altura, unidade)} key={`pa${unidade}`} />
          <Selecao nome="acionamento" rotulo="Acionamento" valor={e.acionamento ?? 'MANUAL'} opcoes={[['MANUAL', 'Manual'], ['MOTORIZADO', 'Motorizado']]} />
          <Selecao nome="ladoComando" rotulo="Lado do comando" valor={e.ladoComando ?? 'DIREITO'} opcoes={[['DIREITO', 'Direito'], ['ESQUERDO', 'Esquerdo']]} />
          <Selecao nome="sentidoEnrolamento" rotulo="Enrolamento" valor={e.sentidoEnrolamento ?? 'NORMAL'} opcoes={[['NORMAL', 'Normal'], ['REVERSO', 'Reverso']]} />
          <CampoTexto nome="qtdControles" rotulo="Controles remotos (se motorizada)" valor={String(controlePadrao)}
            dica="1 controle comanda várias persianas do ambiente" />
          <CampoTexto nome="qtdHubs" rotulo="Hub Wi-Fi (se motorizada)" valor={String(e.qtdHubs ?? 0)} />
          <div className="flex flex-wrap gap-4 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="possuiBando" defaultChecked={Boolean(e.possuiBando)} /> Bandô</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="possuiGuiaLateral" defaultChecked={Boolean(e.possuiGuiaLateral)} /> Guia lateral</label>
          </div>
        </>
      )}
      </Fragment>

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
