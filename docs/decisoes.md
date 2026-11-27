# Decisões da fundação

Registro das escolhas feitas ao montar a base do sistema (estrutura, banco e login).
Itens marcados **SUPOSIÇÃO** ainda precisam de confirmação do Gabriel.

## 1. Só 2 perfis de acesso (decisão do Gabriel, 27/11/2026)

A especificação (seção 12.2) previa 4 perfis. O sistema tem apenas:

| Perfil | Quem é | Resumo |
|---|---|---|
| `ADMIN` | Dono / gestor | Acesso total, inclusive o que seria de FINANCEIRO e INSTALADOR |
| `VENDEDOR` | Vendedor em campo | Clientes, orçamentos, medições e pedidos **próprios**, cálculo e catálogo (preço de venda) |

Matriz de permissões (código: `api/src/auth/permissoes.ts`):

| Permissão | ADMIN | VENDEDOR |
|---|:-:|:-:|
| Ver e editar clientes | ✓ | ✓ |
| Orçamentos / medições / pedidos **próprios** | ✓ | ✓ |
| Orçamentos / medições / pedidos **de todos** | ✓ | — |
| Usar o cálculo de cortina/persiana | ✓ | ✓ |
| Ver catálogo (preço de venda) | ✓ | ✓ |
| Ver custo de fábrica, lucro e margem % | ✓ | só com a opção "pode ver custos" |
| Semáforo de margem (verde/amarelo/vermelho) | ✓ | ✓ |
| Liberar orçamento com margem vermelha | ✓ | — (pede senha do ADMIN) |
| Editar catálogo e preços (inclui tabela de barras) | ✓ | — |
| Fornecedores, compras, produção, instalação | ✓ | — |
| Financeiro, relatórios, DRE | ✓ | — |
| Equipe (criar/desativar usuários) e parâmetros | ✓ | — |

Consequências no banco:

- `perfil_usuario_enum` tem só `ADMIN` e `VENDEDOR`.
- O vendedor em campo é quem faz a medição (`medicoes.tecnico_id` aponta para ele).
- **SUPOSIÇÃO:** sem perfil INSTALADOR, a instalação é feita por equipe/terceiro
  cadastrado em `fornecedores` (categoria `INSTALADOR`). Por isso `pedidos.instalador_id`
  virou `pedidos.instalador_fornecedor_id`. O ADMIN imprime/envia a OS de instalação.
- Mantidos os campos `pode_ver_custos` e `desconto_max_pct` por vendedor.

## 2. Login

- E-mail + senha. Senha guardada com scrypt (nativo do Node), mínimo 8 caracteres com letras e números.
- Sessão em cookie `httpOnly` + `SameSite=Lax`; no banco fica só o SHA-256 do token (tabela `sessoes`).
- Sessão dura 30 dias e renova com o uso (`SESSAO_DIAS`), pensando no vendedor que usa o celular na rua.
- Desativar um usuário, trocar a senha dele ou mudar o perfil derruba as sessões abertas na hora.
- Usuário criado pelo ADMIN recebe senha inicial e precisa trocá-la no primeiro acesso.
- Limite de 10 tentativas de login por minuto por IP; mensagens de erro não revelam se o e-mail existe.
- O primeiro ADMIN é criado pela linha de comando (`npm run admin:criar`).

## 3. Banco

- Estrutura = SQL da seção 8 da especificação v1.1, aplicado por migrações numeradas em
  `api/db/migracoes/` (arquivo aplicado nunca é reexecutado; mudança = arquivo novo).
  Mudanças em relação à especificação estão marcadas com `[fundação]` no SQL.
- Tabelas novas: `sessoes` (login) e `precos_barra_trilho` (preço do trilho por tamanho de
  barra, preenchido pelo Gabriel; a planilha CSV do motor pode ser importada com
  `npm run precos-barra:importar`).
- Entram na migração: categorias, plano de contas, a loja e os parâmetros (semáforo 45/35,
  MEI com alíquota 0%).
- **Produtos não entram na migração**: o Gabriel cadastra o catálogo real. Os SKUs
  fictícios da especificação ficam em `api/db/exemplo/` (`npm run db:exemplo`), só para
  desenvolvimento e demonstração.
- **SUPOSIÇÃO:** limite anual do MEI = R$ 81.000,00 (parâmetro editável). Conferir o valor legal vigente.

## 4. Definições recebidas em 27/11/2026

- **Loja única.** Mantido o `loja_id` da especificação (não custa nada e evita retrabalho),
  mas não há tela nem regra de várias lojas.
- **Nota fiscal fora do sistema** (portal do governo). O pedido só guarda número, chave e
  arquivo da NF-e/NFS-e, como já previa a v1.1.
- **Instalação de cortina sem tamanho máximo:** acima de 3,00 m custa 2x a instalação normal.
  No catálogo de exemplo, SRV-004 e SRV-005 viraram uma faixa só (SRV-004, 2x SRV-001,
  valores fictícios). **Pendente:** o motor de cálculo ainda lança sempre SRV-001; a escolha
  automática da faixa entra junto com o configurador de orçamento.
- **Offline na obra:** a base do PWA já está pronta. Arquitetura em [`offline.md`](offline.md).
- **Markup padrão de 100%** (venda sugerida = 2x o custo), parâmetro `MARKUP_PADRAO_PCT`.
  É só a sugestão de preço ao cadastrar/reajustar produto; o semáforo de margem continua 45%/35%.
- **Status de medição (v1.1):** orçamento ganha `AGUARDANDO_MEDICAO`; no pedido,
  `AGUARDANDO_MEDICAO_FINAL` virou `CONFERENCIA_MEDIDAS` (venda fechada com medida aproximada).

## 5. Stack

| Camada | Escolha | Por quê |
|---|---|---|
| API | Node 22 + TypeScript + Fastify 5 | Leve, rápida e no mesmo idioma do motor de cálculo |
| Banco | PostgreSQL 16 + Drizzle ORM | SQL da especificação aplicado direto; Drizzle só para consultas tipadas |
| Web | Next.js 16 + Tailwind 4 + componentes no padrão shadcn/ui | Sugerido na especificação |
| Cálculo | Pacote `motor-calculo` (já existente) | Importado pela API e, no futuro, pelo app offline. Nada foi duplicado |

O navegador fala só com o Next, que repassa `/api/*` para a API (mesma origem, cookie sem CORS).
