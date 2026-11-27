# Decisões da fundação

Registro das escolhas feitas ao montar a base do sistema (estrutura, banco e login).
Todas as suposições foram confirmadas pelo Gabriel em 27/11/2026.

## 1. Só 2 perfis de acesso (decisão do Gabriel, 27/11/2026)

A especificação (seção 12.2) previa 4 perfis. O sistema tem apenas:

| Perfil | Quem é | Resumo |
|---|---|---|
| `ADMIN` | Dono / gestor | Acesso total, inclusive o que seria de FINANCEIRO e INSTALADOR |
| `VENDEDOR` | Vendedor em campo | Clientes, orçamentos, medições e pedidos **próprios**, cálculo e catálogo (preço de venda) |

Matriz de permissões (código: `api/src/auth/permissoes.ts`):

| Permissão | ADMIN | VENDEDOR |
|---|:-:|:-:|
| Ver e editar clientes | todos | só os **próprios** (é o responsável) |
| Transferir cliente para outro vendedor / inativar | ✓ | — |
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
| Backups do banco (gerar e baixar) | ✓ | — |

Consequências no banco:

- `perfil_usuario_enum` tem só `ADMIN` e `VENDEDOR`.
- O vendedor em campo é quem faz a medição (`medicoes.tecnico_id` aponta para ele).
- **Confirmado pelo Gabriel (27/11/2026):** a instalação é terceirizada; o instalador é
  cadastrado em `fornecedores` (categoria `INSTALADOR`) e não tem login. Por isso `pedidos.instalador_id`
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
- Limite anual do MEI = R$ 110.000,00 (informado pelo Gabriel em 27/11/2026; parâmetro editável).

## 4. Definições recebidas em 27/11/2026

- **Loja única.** Mantido o `loja_id` da especificação (não custa nada e evita retrabalho),
  mas não há tela nem regra de várias lojas.
- **Nota fiscal fora do sistema** (portal do governo). O pedido só guarda número, chave e
  arquivo da NF-e/NFS-e, como já previa a v1.1.
- **Instalação de cortina sem tamanho máximo:** acima de 3,00 m custa 2x a instalação normal.
  No catálogo de exemplo, SRV-004 e SRV-005 viraram uma faixa só (SRV-004, 2x SRV-001,
  valores fictícios). O motor de cálculo escolhe a faixa (e o SRV-006 de pé-direito alto) sozinho.
- **Offline na obra:** a base do PWA já está pronta. Arquitetura em [`offline.md`](offline.md).
- **Markup padrão de 100%** (venda sugerida = 2x o custo), parâmetro `MARKUP_PADRAO_PCT`.
  É só a sugestão de preço ao cadastrar/reajustar produto (`precoVendaSugerido` do motor); o semáforo
  de margem continua 45%/35% (`semaforoMargem` do motor, com os limites lidos do banco).
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

## 6. Cadastros (clientes, fornecedores, catálogo), 27/11/2026

Tudo abaixo foi confirmado pelo Gabriel em 27/11/2026.

- **Cliente tem um vendedor responsável** (`clientes.vendedor_responsavel_id`). Quem cadastra vira o
  responsável; o VENDEDOR vê e edita só os dele; o ADMIN vê todos, transfere e inativa.
  Vendedor não inativa cliente (só o ADMIN), para não sumir histórico por engano.
- **CPF/CNPJ e WhatsApp únicos** (confirmado pelo Gabriel, 27/11/2026): um cadastro por CPF e por
  WhatsApp. CPF guardado só com dígitos (dígito verificador conferido). Se outro vendedor tenta
  cadastrar um CPF ou WhatsApp que já existe, o sistema recusa sem mostrar os dados do outro cliente
  e pede para o ADMIN transferir.
- **Telefone** sempre no padrão `+55DDNNNNNNNNN`; botão "Abrir WhatsApp" usa link `wa.me` (sem custo).
- **Busca** sem acento (`unaccent` + `pg_trgm`): nome (tolera erro de digitação), telefone, CPF, e-mail,
  bairro/cidade e **produto comprado** (descrição dos itens dos pedidos, ex.: "linho", "wave").
- **CEP** preenche o endereço via ViaCEP direto do navegador. Sem internet, digita-se o endereço.
- **Fornecedores**: só ADMIN. Categorias fixas: TECIDO, PERSIANA, FERRAGEM, MOTORIZACAO, COSTUREIRA,
  INSTALADOR, OUTRO. Instalador pessoa física usa CPF no campo de documento; há chave PIX para pagamento.
- **Catálogo**: só o ADMIN cria/edita. Venda em branco = custo + `MARKUP_PADRAO_PCT` (100%). Toda mudança
  de custo/venda vai para `historico_precos_produto`, inclusive cada tamanho da tabela de barras
  (`tamanho_m`). Tabela de barras só para a categoria "Trilhos e Varoes"; o cálculo só cobra por barra
  quando os 6 tamanhos estão preenchidos (regra que já existia no motor). Produto não é apagado, é inativado.
- O VENDEDOR vê o catálogo com preço de venda (inclusive por barra), sem custo e sem fornecedor.

## 7. Configurador de orçamento e proposta, 27/11/2026

Implementado conforme as decisões já tomadas (2 perfis, semáforo 45/35, markup 100%, trilho por barra,
sem rapport, instalação acima de 3 m = 2x). Regras em `motor-calculo/src/configurador.ts` (usadas pela API e
pelo app offline) e `api/src/orcamentos/`.

- **Orçamento = projeto** (cliente + obra), com itens agrupados por **ambiente**. Cada item guarda o que o
  vendedor escolheu (medidas e opções) e a explosão do motor.
- **Edição manual auditada**: trocar, incluir, remover ou mudar a quantidade de componente vira um "ajuste"
  com motivo opcional, aplicado sobre a explosão do motor e registrado em `orcamento_auditoria`.
- **Snapshot**: item que não mudou mantém custo e preço gravados; reajuste do catálogo não altera orçamento
  já feito. Há o botão "Atualizar preços pelo catálogo" para recalcular de propósito.
- **Versões**: só o rascunho da versão mais nova é editável. "Enviar proposta" congela a versão. Mudar uma
  versão enviada, antiga ou editada em outro aparelho grava a próxima versão (v2, v3…), nunca sobrescreve.
- **Desconto e trava**: desconto em % ou R$, rateado entre itens e componentes pelo valor de venda (sobra de
  centavos no maior). Margem do semáforo = **líquida** (após taxa da forma de pagamento, imposto e comissão).
  Precisa da senha do ADMIN quando a margem fica vermelha **ou** o desconto passa do `desconto_max_pct` do
  vendedor. A liberação vale enquanto margem e desconto não piorarem (inclusive na versão seguinte).
- **Vendedor sem "pode ver custos"** não recebe custo, lucro, margem nem taxa; vê o semáforo.
- **PDF da proposta** (pdfkit, gerado na API): agrupado por ambiente, sem custo; "Detalhar componentes" lista
  só nome e quantidade. Aviso "Valores sujeitos a conferência técnica no local" até marcar "medidas conferidas".
- **WhatsApp**: link público do PDF com token, válido até a validade do orçamento, só para versão enviada.
- **Medidas** em metros ou centímetros (o vendedor escolhe); largura acima de 15 m ou altura acima de 10 m
  pede confirmação no app e é recusada pela API.
- **Status**: Rascunho → Enviado → Aguardando medição → Em negociação; Perdido (com motivo) a qualquer momento.
  Aprovar e virar pedido fica para a próxima etapa.

Decididos pelo Gabriel em 27/11/2026 (editáveis em `parametros_sistema` ou no próprio orçamento):
- Validade da proposta: 15 dias.
- Prazo de entrega: 14 dias úteis (12 úteis + 2, sem contar sábado e domingo).
- Garantia por item, no PDF: 12 meses; persiana rolo, double vision e painel 2 anos; motor 5 anos
  (`metadata.garantia_meses` no produto sobrepõe a regra pelo nome).
- Fator de franzimento padrão: wave 2,8; prega macho 3,0; franzido 2,5; forro 1,8. O vendedor pode mudar no item.
- Controle remoto: 1, 6 ou 16 canais (1 canal = 1 peça), calculado pela casa toda. O editor soma as peças
  motorizadas de todo o orçamento e sugere o menor controle que cobre todas (1 peça: 1 canal; 2 a 6: 6 canais;
  7 a 16: 16 canais; acima de 16, vários de 16 + o menor que cobre o resto). O vendedor aplica com
  "Usar sugestão" ou escolhe à mão. Persiana nova vem sem controle se o orçamento já tem um.
