# Sistema Cortinas

ERP para loja de cortinas e persianas sob medida (orçamentos, produção e gestão),
construído a partir da *Especificação Técnica ERP Cortinas e Persianas* v1.1.

## Módulos

| Pasta | Conteúdo | Estado |
|---|---|---|
| [`motor-calculo/`](motor-calculo/README.md) | Motor de cálculo (decimal exato, explosão BOM, alertas técnicos) | Pronto, 63 testes |
| `api/` | API Fastify + PostgreSQL: migrações, login, perfis, clientes, fornecedores, catálogo com histórico de preços, cálculo | Fase 1 |
| `web/` | Next.js + Tailwind (padrão shadcn/ui), PWA: login, painel, equipe, clientes (offline), fornecedores, catálogo e preços | Fase 1 |
| [`docs/`](docs/decisoes.md) | Decisões da fundação e arquitetura offline | |

Perfis de acesso: só **ADMIN** (acesso total) e **VENDEDOR** (vendedor em campo).
Matriz completa em [`docs/decisoes.md`](docs/decisoes.md).

## Rodar no computador

Requer Node 22+ e PostgreSQL 15+ (ou Docker).

```bash
cp .env.example .env
docker compose up -d                # banco local (opcional, se não tiver Postgres)
npm install                         # instala tudo e compila o motor de cálculo
npm run db:migrar                   # cria as tabelas e os dados base
npm run db:exemplo                  # (opcional) catálogo fictício da especificação
npm run admin:criar -- --email voce@loja.com --nome "Seu nome"   # mostra uma senha provisória

npm run dev:api                     # API em http://localhost:3333
npm run dev:web                     # app em http://localhost:3000
```

Preços do trilho por barra: na tela **Catálogo**, abra o trilho e preencha a tabela de 1 a 6 m
(fica no histórico de preços). A planilha `motor-calculo/dados/precos-barra-trilho.csv` continua
servindo para importação em lote com `npm run precos-barra:importar`.

## Colocar no ar (VPS com Easypanel)

`Dockerfile` na raiz gera uma imagem única (site + API). Banco: serviço PostgreSQL do Easypanel.
Migrações e o primeiro ADMIN são criados sozinhos ao iniciar; backup diário com tela para baixar.
Detalhes e variáveis em [`docs/deploy-easypanel.md`](docs/deploy-easypanel.md).

## Testes

```bash
npm test                            # motor + API (a API precisa de DATABASE_URL_TESTE)
npm run typecheck
```

Os testes da API apagam e recriam o banco de `DATABASE_URL_TESTE`; use um banco só para isso.
