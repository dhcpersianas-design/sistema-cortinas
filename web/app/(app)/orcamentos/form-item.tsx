'use client';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { classeSelect } from '@/components/cadastro/campos';
import {
  MODELOS_ACIONAMENTO, acionamentosDoModelo, adicionaisCompativeis, bandosDoModelo, calcularItem, regrasDoModelo, rotuloBando,
  temBando, temGuiaLateral, textoAdicional, textoDisponibilidade, type Catalogo, type EntradaItem,
} from '@sistema/motor-calculo/navegador';
import type { Item, ProdutoCatalogo } from '@/lib/orcamentos-offline';

/**
 * Cadastro de um vão (item) do orçamento: cortina, persiana ou só serviço (sem produto).
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
  /** Catálogo do motor: confere as regras do fabricante enquanto o vendedor digita. */
  catalogo?: Catalogo | null;
  ambientes: string[];
  inicial?: Item;
  ambienteSugerido?: string;
  /** Já existe controle remoto em outra persiana motorizada deste ambiente? */
  temControleNoOrcamento: (ignorarId?: string) => boolean;
  onSalvar: (i: Item) => void;
  onCancelar: () => void;
};

export function FormItem({ produtos, catalogo, ambientes, inicial, ambienteSugerido, temControleNoOrcamento, onSalvar, onCancelar }: Props) {
  const e = (inicial?.entrada ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const [tipo, setTipo] = useState<'CORTINA' | 'PERSIANA' | 'SERVICO'>(inicial?.tipo ?? 'CORTINA');
  // Cortina motorizada = trilho motorizado Slim (sistema completo) no lugar do trilho comum.
  const [cortinaMotor, setCortinaMotor] = useState<boolean>(Boolean(e.trilhoMotorizado));
  const [servicos, setServicos] = useState<{ sku: string; quantidade: string }[]>(() =>
    inicial?.tipo === 'SERVICO' && Array.isArray(e.servicos) ? e.servicos.map((x: { sku: string; quantidade: unknown }) => ({ sku: x.sku, quantidade: String(x.quantidade).replace('.', ',') })) : [{ sku: '', quantidade: '1' }]);
  const [confeccao, setConfeccao] = useState<string>(e.confeccao ?? 'WAVE');
  const [unidade, setUnidade] = useState<Unidade>('m');
  const [erro, setErro] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState<string | null>(null);
  // Modelo escolhido agora (para o quadro de regras). Os selects são livres; o form avisa quando mudam.
  const [escolha, setEscolha] = useState<Record<string, string>>(() => ({
    persiana: e.sku ?? '', tecido: e.tecido?.sku ?? '', forro: e.forro?.sku ?? '', trilho: e.skus?.trilho ?? '', acionamento: e.acionamento ?? 'MANUAL',
    trilhoMotorizado: e.trilhoMotorizado ?? '', modeloAcionamento: e.modeloAcionamento ?? '',
  }));
  const formRef = useRef<HTMLFormElement>(null);
  const [mudancas, setMudancas] = useState(0);
  function aoMudar(ev: React.FormEvent<HTMLFormElement>) {
    const t = ev.target as HTMLSelectElement;
    if (['persiana', 'tecido', 'forro', 'trilho', 'acionamento', 'trilhoMotorizado', 'modeloAcionamento'].includes(t.name)) setEscolha((x) => ({ ...x, [t.name]: t.value }));
    setMudancas((n) => n + 1);
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
      // Trilho motorizado: uma opção por modelo e cor (a 1ª faixa); o cálculo troca para o produto "ATÉ" a largura.
      trilhosMotorizados: produtos.filter((p) => p.metadata?.trilho_motorizado === true && (p.disponibilidade !== 'FORA_DE_LINHA' || atuais.has(p.sku))
        && (!Array.isArray(p.metadata?.faixas_skus) || p.metadata.faixas_skus[0]?.sku === p.sku || atuais.has(p.sku))),
      // Só serviço: produtos da categoria Serviços (instalação, confecção, visita...).
      servicos: produtos.filter((p) => /^servi[cç]os/i.test(p.categoria) || ['INSTALACAO', 'CONFECCAO'].includes(p.perfil ?? '')),
    };
  }, [produtos]);

  const obterProduto = (sku: string) => produtos.find((p) => p.sku === sku);
  // Regras fixas que sempre aparecem: só a do tecido da cortina (largura do rolo e corte em tiras)
  // e produto escolhido que não está disponível. O resto só aparece quando a medida foge do padrão.
  const regrasFixas = useMemo(() => {
    const obter = (sku: string) => produtos.find((p) => p.sku === sku);
    // Sem escolha ainda: vale a primeira opção da lista (é a que aparece selecionada).
    const ou = (v: string | undefined, lista: ProdutoCatalogo[]) => v || lista[0]?.sku;
    if (tipo === 'SERVICO') return { tecido: [], disponibilidade: [] };
    const trilhoMot = cortinaMotor ? ou(escolha.trilhoMotorizado, porCategoria.trilhosMotorizados) : undefined;
    const tecido = tipo === 'CORTINA'
      ? regrasDoModelo({ tipo, confeccao, tecido: ou(escolha.tecido, porCategoria.tecidos), forro: escolha.forro || undefined, trilho: ou(escolha.trilho, porCategoria.trilhos), trilhoMotorizado: trilhoMot }, obter)
        .filter((r) => r.titulo.startsWith('Largura do rolo'))
      : [];
    const disponibilidade = disponibilidadeEscolhida(tipo === 'PERSIANA'
      ? [ou(escolha.persiana, porCategoria.persianas)]
      : [ou(escolha.tecido, porCategoria.tecidos), escolha.forro, cortinaMotor ? trilhoMot : ou(escolha.trilho, porCategoria.trilhos)], obter);
    return { tecido, disponibilidade };
  }, [tipo, confeccao, escolha, produtos, porCategoria, cortinaMotor]);
  /** Persiana escolhida agora: opcionais e modelos de acionamento da linha dela. */
  const persianaAtual = useMemo(() => produtos.find((p) => p.sku === (escolha.persiana || porCategoria.persianas[0]?.sku)), [escolha.persiana, produtos, porCategoria]);
  const persianaMotorizada = escolha.acionamento === 'MOTORIZADO';
  const opcoesBando = bandosDoModelo(persianaAtual, { motorizado: persianaMotorizada, obter: obterProduto });
  const opcionais = adicionaisCompativeis(persianaAtual, { motorizado: persianaMotorizada, modelo: escolha.modeloAcionamento || undefined });

  /** Monta a entrada do item a partir do formulário. `medida` devolve null quando a medida ainda não foi digitada. */
  function lerEntrada(f: FormData, medida: (k: string, rotulo: string, lim: number) => string | null): Record<string, unknown> | null {
    const s = (k: string) => String(f.get(k) ?? '').trim();
    if (tipo === 'CORTINA') {
      const forro = s('forro');
      const larguraTrilho = medida('largura', 'Largura do trilho', LIM.largura);
      const alturaPronta = medida('altura', 'Altura pronta', LIM.altura);
      if (!larguraTrilho || !alturaPronta) return null;
      return {
        larguraTrilho, alturaPronta,
        numFolhas: Number(s('numFolhas')) as 1 | 2,
        confeccao: s('confeccao'),
        // Fator em branco = padrão do motor (wave 2,8; prega macho 3,0; franzido 2,5; forro 1,8).
        tecido: { sku: s('tecido'), ...(s('fator') ? { fator: s('fator').replace(',', '.') } : {}) },
        ...(forro ? { forro: { sku: forro, ...(s('fatorForro') ? { fator: s('fatorForro').replace(',', '.') } : {}) } } : {}),
        skus: {
          ...(cortinaMotor ? {} : { trilho: s('trilho') }),
          ...(s('maoObra') ? { maoObraTecido: s('maoObra') } : {}),
          ...(cortinaMotor && s('controle') ? { controle: s('controle') } : {}),
        },
        ...(cortinaMotor ? { trilhoMotorizado: s('trilhoMotorizado'), qtdControles: s('controle') ? 1 : 0 } : {}),
      };
    }
    const modo = s('modoMedida');
    const larg = medida('largura', 'Largura', LIM.largura);
    const alt = medida('altura', 'Altura', LIM.altura);
    if (!larg || !alt) return null;
    const motor = s('acionamento') === 'MOTORIZADO';
    const bando = f.get('possuiBando') === 'on';
    return {
      sku: s('persiana'),
      medida: modo === 'PRODUCAO' ? { tipo: 'PRODUCAO', largura: larg, altura: alt } : { tipo: 'VAO_BRUTO', modo, largura: larg, altura: alt },
      acionamento: s('acionamento'), ladoComando: s('ladoComando'), sentidoEnrolamento: s('sentidoEnrolamento'),
      possuiBando: bando, ...(bando && s('skuBando') ? { skuBando: s('skuBando') } : {}),
      possuiGuiaLateral: f.get('possuiGuiaLateral') === 'on',
      ...(s('modeloAcionamento') ? { modeloAcionamento: s('modeloAcionamento') } : {}),
      ...(f.getAll('adicional').length ? { adicionais: f.getAll('adicional').map(String) } : {}),
      ...(motor ? {
        qtdControles: s('controle') ? 1 : 0, qtdHubs: inteiro(s('qtdHubs'), 'Hub Wi-Fi'),
        ...(s('controle') ? { skus: { controle: s('controle') } } : {}),
      } : {}),
    };
  }

  // Conferência ao vivo: calcula o item com o que está digitado e mostra só o que foge do padrão do fabricante.
  const [previa, setPrevia] = useState<{ avisos: { critico: boolean; texto: string }[] } | null>(null);
  useEffect(() => {
    const form = formRef.current;
    if (!form || !catalogo || tipo === 'SERVICO') { setPrevia(null); return; }
    const f = new FormData(form);
    let entrada: Record<string, unknown> | null = null;
    try { entrada = lerEntrada(f, (k) => paraMetros(String(f.get(k) ?? '').trim(), unidade)); } catch { entrada = null; }
    if (!entrada) { setPrevia(null); return; }
    try {
      const r = calcularItem({ tipo, entrada } as unknown as EntradaItem, [], catalogo);
      setPrevia({ avisos: r.alertas.filter((a) => a.codigo !== 'BANDO_INCLUSO').map((a) => ({ critico: a.severidade === 'CRITICO', texto: a.mensagem })) });
    } catch (err) {
      setPrevia({ avisos: [{ critico: true, texto: (err as Error).message }] });
    }
  }, [mudancas, tipo, cortinaMotor, confeccao, unidade, escolha, catalogo]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (tipo === 'SERVICO') {
        const linhas = servicos.filter((x) => x.sku);
        if (linhas.length === 0) throw new Error('Escolha pelo menos um serviço.');
        const vistos = new Set<string>();
        entrada = {
          servicos: linhas.map((x) => {
            if (vistos.has(x.sku)) throw new Error('O mesmo serviço aparece duas vezes: some as quantidades numa linha só.');
            vistos.add(x.sku);
            const q = x.quantidade.trim().replace(',', '.');
            if (!/^\d+(\.\d+)?$/.test(q) || Number(q) <= 0) throw new Error('Quantidade do serviço: use um número maior que zero.');
            return { sku: x.sku, quantidade: q };
          }),
          ...(s('descricaoServico') ? { descricao: s('descricaoServico') } : {}),
        };
      } else {
        entrada = lerEntrada(f, medida)!;
        if (tipo === 'CORTINA' && cortinaMotor && !s('trilhoMotorizado')) throw new Error('Cadastre ou escolha o trilho motorizado.');
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
  const jaMotorizado = (inicial?.tipo === 'PERSIANA' && e.acionamento === 'MOTORIZADO') || (inicial?.tipo === 'CORTINA' && e.trilhoMotorizado);
  const controlePadrao = jaMotorizado
    ? ((e.qtdControles ?? 1) > 0 ? (e.skus?.controle ?? 'MOT-002') : '')
    : (temControleNoOrcamento(inicial?.id) ? '' : (porCategoria.controles[0]?.sku ?? ''));

  return (
    <form ref={formRef} onSubmit={salvar} onChange={aoMudar} className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ambiente">Ambiente</Label>
        <Input id="ambiente" name="ambiente" list="lista-ambientes" defaultValue={ambienteInicial} placeholder="Sala, Quarto casal…" required />
        <datalist id="lista-ambientes">{ambientes.map((a) => <option key={a} value={a} />)}</datalist>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Tipo</Label>
        <div className="flex gap-2">
          {(['CORTINA', 'PERSIANA', 'SERVICO'] as const).map((t) => (
            <Button key={t} type="button" variant={tipo === t ? 'default' : 'outline'} className="flex-1" onClick={() => setTipo(t)}>
              {t === 'CORTINA' ? 'Cortina' : t === 'PERSIANA' ? 'Persiana' : 'Serviço'}
            </Button>
          ))}
        </div>
      </div>

      {tipo !== 'SERVICO' && <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label>Medidas em</Label>
        <div className="flex gap-2">
          {(['m', 'cm'] as const).map((u) => (
            <Button key={u} type="button" size="sm" variant={unidade === u ? 'default' : 'outline'} onClick={() => setUnidade(u)}>
              {u === 'm' ? 'Metros (2,60)' : 'Centímetros (260)'}
            </Button>
          ))}
        </div>
      </div>}

      {/* key por tipo: trocar cortina/persiana não reaproveita os campos do outro tipo */}
      <Fragment key={tipo}>
      {tipo === 'SERVICO' ? (
        <>
          <p className="text-sm text-muted-foreground sm:col-span-2">Só serviço, sem produto (ex.: instalar ou consertar a persiana que o cliente já tem).</p>
          {porCategoria.servicos.length === 0 && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">Nenhum serviço ativo no Catálogo. Cadastre em Catálogo › Serviços.</p>
          )}
          {servicos.map((linha, n) => (
            <div key={n} className="flex flex-wrap items-end gap-2 sm:col-span-2">
              <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                <Label htmlFor={`servico-${n}`}>Serviço {servicos.length > 1 ? n + 1 : ''}</Label>
                <select id={`servico-${n}`} value={linha.sku} className={classeSelect}
                  onChange={(ev) => setServicos((l) => l.map((x, i) => (i === n ? { ...x, sku: ev.target.value } : x)))}>
                  <option value="">Escolha…</option>
                  {porCategoria.servicos.map((p) => <option key={p.sku} value={p.sku}>{p.nome} ({p.sku}){sufixoStatus(p)}</option>)}
                </select>
              </div>
              <div className="flex w-24 flex-col gap-1.5">
                <Label htmlFor={`qtd-servico-${n}`}>Quantidade</Label>
                <Input id={`qtd-servico-${n}`} inputMode="decimal" value={linha.quantidade}
                  onChange={(ev) => setServicos((l) => l.map((x, i) => (i === n ? { ...x, quantidade: ev.target.value } : x)))} />
              </div>
              {servicos.length > 1 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setServicos((l) => l.filter((_, i) => i !== n))}>Tirar</Button>
              )}
            </div>
          ))}
          <div className="sm:col-span-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setServicos((l) => [...l, { sku: '', quantidade: '1' }])}>+ Outro serviço</Button>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="descricaoServico">Descrição para o cliente (opcional)</Label>
            <Input id="descricaoServico" name="descricaoServico" defaultValue={e.descricao ?? ''} placeholder="Ex.: Reinstalação de 3 persianas do cliente" />
            <span className="text-xs text-muted-foreground">Em branco: vai o nome dos serviços.</span>
          </div>
        </>
      ) : tipo === 'CORTINA' ? (
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
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label>Acionamento</Label>
            <div className="flex gap-2">
              {[false, true].map((m) => (
                <Button key={String(m)} type="button" size="sm" variant={cortinaMotor === m ? 'default' : 'outline'} onClick={() => setCortinaMotor(m)}>
                  {m ? 'Motorizada (trilho motorizado)' : 'Manual'}
                </Button>
              ))}
            </div>
          </div>
          {cortinaMotor ? (
            <>
              <Selecao nome="trilhoMotorizado" rotulo="Trilho motorizado" largo valor={e.trilhoMotorizado ?? porCategoria.trilhosMotorizados.find((p) => p.metadata?.modelo === (confeccao === 'WAVE' ? 'WAVE' : 'FRANZIDA'))?.sku}
                opcoes={porCategoria.trilhosMotorizados.map((p) => [p.sku, Array.isArray(p.metadata?.faixas_skus)
                  ? `${String(p.nome).replace(/ - ATÉ [\d,.]+ ?MT?/i, '')} · faixa escolhida pela largura${sufixoStatus(p)}`
                  : `${p.nome} (${p.sku})${sufixoStatus(p)}`])} />
              <Selecao nome="controle" rotulo="Controle remoto (não vem com o trilho)" valor={controlePadrao} largo
                opcoes={[['', 'Sem controle neste item (usa o de outra peça)'], ...porCategoria.controles.map((p) => [p.sku, `${p.nome} (${p.metadata.canais} canal/is)`] as [string, string])]} />
            </>
          ) : (
            <Selecao nome="trilho" rotulo="Trilho / varão" valor={e.skus?.trilho} opcoes={porCategoria.trilhos.map((p) => [p.sku, `${p.nome} (${p.sku})${p.tabelaBarrasCompleta ? ' · por barra' : ''}${sufixoStatus(p)}`])} largo />
          )}
        </>
      ) : (
        <>
          <Selecao nome="persiana" rotulo="Persiana" valor={e.sku} opcoes={porCategoria.persianas.map((p) => [p.sku, `${p.nome} (${p.sku})${sufixoStatus(p)}`])} largo />
          <Selecao nome="modoMedida" rotulo="A medida é" valor={e.medida?.tipo === 'VAO_BRUTO' ? e.medida.modo : 'PRODUCAO'} largo
            opcoes={[['PRODUCAO', 'Medida final da persiana'], ['DENTRO_VAO', 'Vão bruto, instalação dentro do vão'], ['FORA_VAO', 'Vão bruto, instalação fora do vão'], ['TETO', 'Vão bruto, instalação no teto']]} />
          <CampoMedida nome="largura" rotulo={`Largura (${medidaRotulo})`} valor={deMetros(Array.isArray(e.medida?.largura) ? e.medida.largura[0] : e.medida?.largura, unidade)} key={`pl${unidade}`} />
          <CampoMedida nome="altura" rotulo={`Altura (${medidaRotulo})`} valor={deMetros(Array.isArray(e.medida?.altura) ? e.medida.altura[0] : e.medida?.altura, unidade)} key={`pa${unidade}`} />
          <Selecao nome="acionamento" rotulo="Acionamento" valor={e.acionamento ?? 'MANUAL'} opcoes={[['MANUAL', 'Manual'], ['MOTORIZADO', 'Motorizado']]} />
          {acionamentosDoModelo(persianaAtual).length > 0 && (
            <Selecao key={`ac-${persianaAtual?.sku}`} nome="modeloAcionamento" rotulo="Modelo de acionamento" largo
              valor={e.sku === persianaAtual?.sku ? e.modeloAcionamento ?? '' : ''}
              opcoes={[['', 'Não informar'], ...acionamentosDoModelo(persianaAtual).map((a) => [a, MODELOS_ACIONAMENTO[a] ?? `Modelo ${a}`] as [string, string])]} />
          )}
          <Selecao nome="ladoComando" rotulo="Lado do comando" valor={e.ladoComando ?? 'DIREITO'} opcoes={[['DIREITO', 'Direito'], ['ESQUERDO', 'Esquerdo']]} />
          <Selecao nome="sentidoEnrolamento" rotulo="Enrolamento" valor={e.sentidoEnrolamento ?? 'NORMAL'} opcoes={[['NORMAL', 'Normal'], ['REVERSO', 'Reverso']]} />
          {/* Manual é só manual: controle e hub só aparecem na motorizada. */}
          {persianaMotorizada && (
            <>
              <Selecao nome="controle" rotulo="Controle remoto" valor={controlePadrao}
                opcoes={[['', 'Sem controle neste item (usa o de outra persiana)'], ...porCategoria.controles.map((p) => [p.sku, `${p.nome} (${p.metadata.canais} canal/is)`] as [string, string])]} />
              <CampoTexto nome="qtdHubs" rotulo="Hub Wi-Fi" valor={String(e.qtdHubs ?? 0)} />
            </>
          )}
          {/* Bandô/sanefa e guia lateral só quando a linha tem a peça certa para ela. */}
          {((temBando(persianaAtual) && (opcoesBando.length > 0 || bandosDoModelo(persianaAtual).length === 0)) || temGuiaLateral(persianaAtual)) && (
            <div key={`ac-${persianaAtual?.sku}-${escolha.acionamento}`} className="flex flex-wrap gap-4 sm:col-span-2">
              {temBando(persianaAtual) && (opcoesBando.length > 0 || bandosDoModelo(persianaAtual).length === 0) && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="possuiBando" defaultChecked={e.sku === persianaAtual?.sku && Boolean(e.possuiBando)} />
                  {opcoesBando.length === 1 ? `${obterProduto(opcoesBando[0]!)?.nome ?? rotuloBando(persianaAtual)} (opcional, à parte)` : `${rotuloBando(persianaAtual)} (opcional, à parte)`}
                </label>
              )}
              {temGuiaLateral(persianaAtual) && (
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="possuiGuiaLateral" defaultChecked={e.sku === persianaAtual?.sku && Boolean(e.possuiGuiaLateral)} /> Guia lateral</label>
              )}
            </div>
          )}
          {opcoesBando.length > 1 && (
            <Selecao key={`bd-${persianaAtual?.sku}-${escolha.acionamento}`} nome="skuBando" rotulo={`Modelo do ${rotuloBando(persianaAtual).toLowerCase()} (se marcado)`} largo
              valor={e.sku === persianaAtual?.sku && e.skuBando && opcoesBando.includes(e.skuBando) ? e.skuBando : opcoesBando[0]}
              opcoes={opcoesBando.map((sku) => [sku, `${obterProduto(sku)?.nome ?? sku} (${sku})`] as [string, string])} />
          )}
          {opcionais.length > 0 && (
            <fieldset key={`ad-${persianaAtual?.sku}-${escolha.acionamento}-${escolha.modeloAcionamento}`} className="flex flex-col gap-1.5 sm:col-span-2">
              <legend className="mb-1 text-sm font-medium">Opcionais desta linha</legend>
              {opcionais.map((a) => (
                <label key={a.codigo} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="adicional" value={a.codigo}
                    defaultChecked={e.sku === persianaAtual?.sku && Array.isArray(e.adicionais) && e.adicionais.includes(a.codigo)} />
                  {textoAdicional(a)}
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
      </Fragment>

      {tipo !== 'SERVICO' && (
        <QuadroRegras previa={previa} disponibilidade={regrasFixas.disponibilidade} tecido={regrasFixas.tecido} conferindo={Boolean(catalogo)} />
      )}

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

/**
 * Quadro de regras do fabricante. Só para o vendedor: não vai para o PDF.
 * Mostra SÓ o que foge do padrão com a medida digitada; se nada foge, um check verde.
 * Exceção: a regra do tecido da cortina (largura do rolo / corte em tiras) aparece sempre.
 */
export function QuadroRegras({ previa, disponibilidade, tecido, conferindo }: {
  previa: { avisos: { critico: boolean; texto: string }[] } | null;
  disponibilidade: { titulo: string; texto: string }[];
  tecido: { titulo: string; texto: string }[];
  conferindo: boolean;
}) {
  const avisos = [...disponibilidade.map((r) => ({ critico: false, texto: `${r.titulo}: ${r.texto}` })), ...(previa?.avisos ?? [])];
  return (
    <div className="flex flex-col gap-2 sm:col-span-2">
      {avisos.length > 0 ? (
        <div role="note" className="rounded-md border border-amber-500/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-semibold">⚠ Atenção: fora do padrão do fabricante</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {avisos.map((a, n) => <li key={n} className={a.critico ? 'font-medium text-red-700 dark:text-red-300' : ''}>{a.critico ? 'Crítico: ' : ''}{a.texto.replace(/(\d)\.(\d{2})(?=\s?m)/g, '$1,$2')}</li>)}
          </ul>
          <p className="mt-1 text-xs opacity-80">Só para você. O cliente não vê isto na proposta.</p>
        </div>
      ) : previa ? (
        <div role="status" className="flex items-center gap-2 rounded-md border border-emerald-500/50 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
          <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs text-white">✓</span>
          A peça segue os padrões normais do fabricante.
        </div>
      ) : conferindo ? (
        <p className="text-xs text-muted-foreground">Informe as medidas para conferir as regras do fabricante.</p>
      ) : null}
      {tecido.length > 0 && (
        <div role="note" className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
          {tecido.map((r, n) => <p key={n}><span className="font-medium">{r.titulo}:</span> {r.texto}</p>)}
        </div>
      )}
    </div>
  );
}
