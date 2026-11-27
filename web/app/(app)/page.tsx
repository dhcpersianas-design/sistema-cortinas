import Link from 'next/link';
import { exigirUsuario } from '@/lib/sessao';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type Modulo = { titulo: string; descricao: string; permissao: string; href?: string };

// Ordem das fases da especificação (seção 13). Sem href = ainda não construído.
const MODULOS: Modulo[] = [
  { titulo: 'Catálogo', descricao: 'Produtos, preços e tabela de barras do trilho', permissao: 'catalogo.ver', href: '/catalogo' },
  { titulo: 'Clientes', descricao: 'Cadastro, histórico e pesquisa por nome, telefone ou produto (funciona offline)', permissao: 'clientes.ver', href: '/clientes' },
  { titulo: 'Fornecedores', descricao: 'Fábricas, ateliês e instaladores terceirizados', permissao: 'fornecedores.ver', href: '/fornecedores' },
  { titulo: 'Orçamentos', descricao: 'Configurador por ambiente com cálculo automático', permissao: 'orcamentos.proprios' },
  { titulo: 'Medições', descricao: 'Medição técnica no local, gera a versão v2', permissao: 'medicoes.proprias' },
  { titulo: 'Pedidos', descricao: 'Pedidos aprovados e andamento', permissao: 'pedidos.proprios' },
  { titulo: 'Compras e produção', descricao: 'Ordens por fornecedor e ficha de corte', permissao: 'compras.gerenciar' },
  { titulo: 'Instalação', descricao: 'Agenda, OS e aceite digital', permissao: 'instalacao.gerenciar' },
  { titulo: 'Financeiro', descricao: 'Contas a pagar e receber, DAS MEI', permissao: 'financeiro.gerenciar' },
  { titulo: 'Relatórios', descricao: 'Os 8 relatórios gerenciais e DRE', permissao: 'relatorios.ver' },
  { titulo: 'Equipe', descricao: 'Usuários, perfis e acesso a custos', permissao: 'usuarios.gerenciar', href: '/equipe' },
];

export default async function Painel() {
  const u = await exigirUsuario();
  const meus = MODULOS.filter((m) => u.permissoes.includes(m.permissao));
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Olá, {u.nome.split(' ')[0]}</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        {u.perfil === 'ADMIN' ? 'Acesso total.' : u.podeVerCustos ? 'Vendedor com acesso a custos.' : 'Vendedor: você vê preço de venda e o semáforo de margem.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {meus.map((m) => {
          const card = (
            <Card className={m.href ? 'h-full transition-colors hover:bg-muted' : 'h-full opacity-70'}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>{m.titulo}</CardTitle>
                  {!m.href && <Badge className="text-muted-foreground">Em breve</Badge>}
                </div>
                <CardDescription>{m.descricao}</CardDescription>
              </CardHeader>
            </Card>
          );
          return m.href ? <Link key={m.titulo} href={m.href}>{card}</Link> : <div key={m.titulo}>{card}</div>;
        })}
      </div>
    </div>
  );
}
