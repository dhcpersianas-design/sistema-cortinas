import Link from 'next/link';
import {
  Blinds, CalendarDays, ChartColumn, ChevronRight, ClipboardList, DatabaseBackup, Factory, FileText,
  PhoneCall, TriangleAlert, Truck, UserCog, Users, Wallet, Wrench, type LucideIcon,
} from 'lucide-react';
import { apiServidor, exigirUsuario } from '@/lib/sessao';
import { Badge } from '@/components/ui/badge';

type Modulo = { titulo: string; descricao: string; permissao: string; href?: string; icone: LucideIcon; grupo: Grupo };
type Grupo = 'Vendas' | 'Operação' | 'Cadastros' | 'Gestão';

// Ordem das fases da especificação (seção 13). Sem href = ainda não construído.
// Os cards são o menu do sistema (a barra do topo só tem Voltar e Início).
const MODULOS: Modulo[] = [
  { titulo: 'Orçamentos', descricao: 'Configurador por ambiente, proposta em PDF e WhatsApp (funciona offline)', permissao: 'orcamentos.proprios', href: '/orcamentos', icone: FileText, grupo: 'Vendas' },
  { titulo: 'Agenda e medição', descricao: 'Visitas de medição e instalações da semana; medir na obra com fotos do vão (funciona offline)', permissao: 'medicoes.proprias', href: '/agenda', icone: CalendarDays, grupo: 'Vendas' },
  { titulo: 'Clientes', descricao: 'Cadastro, histórico e pesquisa por nome, telefone ou produto (funciona offline)', permissao: 'clientes.ver', href: '/clientes', icone: Users, grupo: 'Vendas' },
  { titulo: 'Pedidos', descricao: 'Orçamento aprovado vira pedido: medição, aditivo, sinal e andamento', permissao: 'pedidos.proprios', href: '/pedidos', icone: ClipboardList, grupo: 'Operação' },
  { titulo: 'Compras e produção', descricao: 'Ordens por fornecedor, ficha de corte e pedido de fábrica', permissao: 'compras.gerenciar', href: '/compras', icone: Truck, grupo: 'Operação' },
  { titulo: 'Instalações', descricao: 'Agenda, OS e aceite do cliente na obra (funciona offline)', permissao: 'pedidos.proprios', href: '/instalacoes', icone: Wrench, grupo: 'Operação' },
  { titulo: 'Pós-venda', descricao: 'Ligar para o cliente depois da instalação e anotar a avaliação', permissao: 'pedidos.proprios', href: '/pos-venda', icone: PhoneCall, grupo: 'Operação' },
  { titulo: 'Catálogo', descricao: 'Produtos, preços e tabela de barras do trilho', permissao: 'catalogo.ver', href: '/catalogo', icone: Blinds, grupo: 'Cadastros' },
  { titulo: 'Fornecedores', descricao: 'Fábricas, ateliês e instaladores terceirizados', permissao: 'fornecedores.ver', href: '/fornecedores', icone: Factory, grupo: 'Cadastros' },
  { titulo: 'Financeiro', descricao: 'Contas a receber e a pagar, taxas do cartão, DAS e limite do MEI', permissao: 'financeiro.gerenciar', href: '/financeiro', icone: Wallet, grupo: 'Gestão' },
  { titulo: 'Relatórios', descricao: 'DRE, faturamento, lucro por pedido, fluxo de caixa e mais (PDF e Excel)', permissao: 'relatorios.ver', href: '/relatorios', icone: ChartColumn, grupo: 'Gestão' },
  { titulo: 'Equipe', descricao: 'Usuários, perfis e acesso a custos', permissao: 'usuarios.gerenciar', href: '/equipe', icone: UserCog, grupo: 'Gestão' },
  { titulo: 'Backups', descricao: 'Cópias de segurança do banco: baixar e conferir a cópia diária', permissao: 'backups.gerenciar', href: '/backups', icone: DatabaseBackup, grupo: 'Gestão' },
];
const GRUPOS: Grupo[] = ['Vendas', 'Operação', 'Cadastros', 'Gestão'];

function saudacao() {
  const h = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

export default async function Painel() {
  const u = await exigirUsuario();
  const meus = MODULOS.filter((m) => u.permissoes.includes(m.permissao));
  // Alerta do limite do MEI (só para o administrador).
  const mei = u.permissoes.includes('financeiro.gerenciar')
    ? (await apiServidor<{ mei: { mensagem: string | null; nivel: string } }>('/api/financeiro/mei')).dados?.mei ?? null
    : null;
  const hoje = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date());
  return (
    <div className="entrar">
      <section className="mb-8">
        <p className="mb-1 text-sm font-medium text-muted-foreground first-letter:uppercase">{hoje}</p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {saudacao()}, <span className="texto-marca">{u.nome.split(' ')[0]}</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {u.perfil === 'ADMIN' ? 'Acesso total.' : u.podeVerCustos ? 'Vendedor com acesso a custos.' : 'Vendedor: você vê preço de venda e o semáforo de margem.'}
        </p>
      </section>

      {mei?.mensagem && (
        <Link
          href="/financeiro"
          className={`mb-6 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${mei.nivel === 'ESTOUROU' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-amber-500/40 bg-amber-500/10'}`}
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{mei.mensagem}</span>
        </Link>
      )}

      <div className="flex flex-col gap-8">
        {GRUPOS.map((g) => {
          const doGrupo = meus.filter((m) => m.grupo === g);
          if (!doGrupo.length) return null;
          return (
            <section key={g}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{g}</h2>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                {doGrupo.map((m) => <CardModulo key={m.titulo} m={m} />)}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CardModulo({ m }: { m: Modulo }) {
  const Icone = m.icone;
  const conteudo = (
    <>
      <span className="flex size-11 shrink-0 items-center sm:size-12 justify-center rounded-xl bg-accent text-accent-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
        <Icone className="size-6" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="font-semibold leading-tight">{m.titulo}</span>
          {!m.href && <Badge className="text-muted-foreground">Em breve</Badge>}
        </span>
        <span className="mt-0.5 line-clamp-2 hidden text-sm text-muted-foreground sm:block">{m.descricao}</span>
      </span>
      {m.href && <ChevronRight className="size-5 shrink-0 self-center text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary max-sm:hidden" aria-hidden />}
    </>
  );
  // iPhone: 2 cards por linha, só ícone e nome. PC: ícone, nome e descrição.
  const base = 'group flex h-full flex-col items-start gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-all sm:flex-row sm:gap-4 sm:p-5';
  return m.href
    ? <Link href={m.href} className={`${base} hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-marca active:scale-[0.99]`}>{conteudo}</Link>
    : <div className={`${base} opacity-70`}>{conteudo}</div>;
}
