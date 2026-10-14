# KanguruSystem — Memória permanente do projeto

> Este arquivo é carregado automaticamente pelo Claude Code em toda sessão.
> Ele é a **fonte única de contexto** do projeto e substitui os relatórios de handoff (v1–v4).
> **Regra de ouro:** ao final de cada etapa concluída, decisão tomada ou descoberta importante,
> ATUALIZE este arquivo (seções 5, 6, 7 e 12) e faça commit. Se a conversa se perder, nada se perde.

---

## 1. Contexto do negócio

- O dono do projeto comprou a loja **"BeB Games Campo Grande"** (Rio de Janeiro), da rede de franquia BeB Games
  (games, computadores, peças, cartas Pokémon), com contrato de cessão e parceria comercial de 48 meses
  (repasse variável sobre faturamento ao cedente).
- Também tem os quiosques de doces **Fini**, com sistema à parte ("Annadu ERP"), que **NÃO faz parte deste projeto**.
- Ele constrói sozinho um sistema de gestão próprio (ERP + PDV) para a rede BeB Games e planeja
  **comercializá-lo para outros franqueados**.
- Modelo de cobrança definido: mensalidade fixa (ERP+PDV) + taxa de instalação + mensalidade extra por terminal/PDV adicional.
- Trata o projeto como **produto sério, não MVP apressado**: fazer certo > fazer rápido.

---

## 2. Como trabalhar com este usuário (OBRIGATÓRIO)

1. **Ele não programa** (trabalha 100% via IA). Explique decisões em linguagem simples, sem jargão, e peça aprovação nos pontos de decisão.
2. **Fluxo obrigatório:** investigar → propor desenho → usuário aprova/ajusta → implementar → testar → relatar.
   Nunca pular a aprovação do desenho (isso aconteceu na 2.7 e gerou código sem revisão).
3. **Nunca presumir** schema, nome de coluna, tipo ou nome de função. Confirmar contra o **Supabase ATIVO**
   (as migrations do repositório podem divergir do banco real).
4. Respostas de conversa **curtas e objetivas**. Prompts, revisões e relatórios técnicos podem ser completos.
5. Segurança multi-tenant exige cuidado redobrado (já houve vazamento real entre tenants, corrigido).
6. Mudanças em RPCs de produção (venda, estorno, caixa) devem ser **aditivas**: nunca quebrar o que já está validado.
7. **Não aplicar migrations, `supabase db push` nem comandos destrutivos sem aprovação explícita** do usuário.
   O Supabase CLI está linkado ao projeto em `KanguruERP/supabase/.temp` — isso NÃO é autorização para usá-lo.
8. Idioma: português do Brasil.

---

## 3. Arquitetura

- **Repositório único** privado no GitHub: `henryzinhosz/KanguruSystem`. Branch principal: `main`.
- `KanguruERP/` — sistema web: React 19 + Vite + Tailwind + Recharts + Supabase. Hospedado na **Vercel**.
  - `npm run dev` (porta 3000), `npm run build`, `npm run lint` (= `tsc --noEmit`).
- `KanguruPDV/` — app desktop **Tauri (Rust/Cargo) + React**, roda no computador/tablet de cada loja.
  - `npm run dev`, `npm run build` (= `tsc --noEmit && vite build`), `npm run tauri`.
  - Docs internas: `KanguruPDV/docs/` (ativação de terminal, caixa, pré-requisitos do Supabase), checklist em `KanguruPDV/Cheklist.MD`.
- **Banco:** um único Supabase compartilhado pelos dois apps — projeto `qnxmboxwluuyjvgiqlbm`.
- **Onde ficam as coisas do Supabase:**
  - Migrations ATUAIS: `KanguruERP/supabase/migrations/` (2.5 em diante).
  - Migrations antigas (fases 0–2.4): `supabase/_legado/erp/` e `supabase/_legado/pdv/`.
  - Edge Functions: `supabase/functions/` (ex.: `create-tenant-admin`).
  - `KanguruERP/src/db/supabaseService.ts` contém scripts SQL antigos embutidos em strings — **não são a versão viva**; a versão vigente de cada função é a da migration mais recente.
- Ferramentas de IA usadas: Copilot → Claude Code (decidido continuar no Claude Code, chat do VS Code; Codex foi avaliado e descartado).
- Workspace no HD externo (D:), backup local em `Henry Tech LTDA\Backups` e cópia no Google Drive.
- Arquivos `.env` e `supabase/.temp/` **nunca** vão para o Git (já no `.gitignore`).
- Git local deste repositório configurado com autor `henryzinhosz <luizedu31031@gmail.com>`.

### Padrões de segurança (não misturar!)
- **Usuário do ERP:** valida via `app_users` / `public.current_user_tenant_id()` / `public.current_user_has_store_access(tenant_id, unit_id)`.
- **Sessão de terminal do PDV:** valida via `pos_terminals` com `device_auth_uid = auth.uid()` e `is_active`.
- Misturar os dois já causou "Acesso negado à loja".
- RPCs sensíveis: `SECURITY DEFINER`, `SET search_path`, `REVOKE ... FROM PUBLIC, anon` e `GRANT EXECUTE ... TO authenticated`.
- Tabelas: RLS ligado; escrita do PDV somente via RPC.

### Papéis
- `SUPER_ADMIN`: usa **só o UCP** (painel da plataforma), nunca o ERP operacional.
- Para uso diário do ERP o dono tem uma segunda conta `ADMIN` normal.
- Vendedores do PDV (`pdv_operators`): sem login, nome + permissões em JSONB, isolados por tenant.

---

## 4. Glossário rápido

- **Tenant:** cada cliente (franqueado) do sistema. Tudo tem `tenant_id`.
- **Loja / unit_id:** unidade física de um tenant (`store_configs`).
- **Terminal:** um PDV ativado com código único (`pos_terminals`), com senha administrativa (`admin_password_hash`).
- **UCP:** painel da plataforma (criar clientes, assinatura, códigos de ativação).
- **Sinal:** valor pago antecipado numa reserva (`pos_reservation_payments`).
- **Sangria/Suprimento:** retirada/entrada de dinheiro no caixa (`cash_register_movements`).

---

## 5. Roadmap e status

### Fase 0 — Base do ERP: ✅ CONCLUÍDA
Schema, RLS, login real, telas lendo/gravando do Supabase.

### Fase 1 — Multi-tenant + UCP: ✅ CONCLUÍDA
Tabela `tenants`, `tenant_id` em tudo, RLS revisado, `SUPER_ADMIN` isolado, UCP (criar cliente via Edge Function,
listar tenants, `subscription_status`, código de ativação de terminal). Estoque com sub-abas "Cadastro de Produto" e
"Entrada de Estoque" (multi-loja). `pdv_operators` com seção espelhada no UCP.

### Fase 2 — PDV: 🟡 EM ANDAMENTO
Autenticação: ativação de terminal (código único) + senha administrativa por terminal. Sem login individual nem PIN
por operador (inspirado no Linx Degust).

| Sub-fase | Status |
|---|---|
| 2.0 Estrutura Tauri | ✅ |
| 2.1 Ativação de terminal + senha administrativa (`keyring` com feature `windows-native`) | ✅ |
| 2.2 Abertura/fechamento de caixa (sangria/suprimento, esperado × contado) | ✅ |
| 2.3 Catálogo e busca (SKU/nome/marca, leitor de código via foco+Enter, auto-adição por SKU exato) | ✅ |
| 2.4 Produtos serializados (`product_serial_units` DISPONIVEL/VENDIDO/RESERVADO, `mark_serial_units_sold`) | ✅ |
| 2.5 Serviços e carrinho (`services`, `max_item_discount_percent`, `search_pos_items`, desconto por linha) | ✅ |
| 2.6 Reserva de produto (`product_reservations`, sinal em ledger próprio, preço/desconto congelado) | ✅ |
| 2.7 Pagamento dividido + aprovação de desconto | 🟡 Revisada, **migration NÃO aplicada**, testes pendentes (seção 6) |
| 2.7b Etiquetas, código de barras e custo por unidade | 🔵 Desenho em discussão (seção 7) — fazer ANTES da 2.8 |
| 2.8 Finalização da venda (fiscal, garantia) | ⚪ Não iniciada |
| 2.9 Trocas e devoluções | ⚪ |
| 2.10 Interface para tablet | ⚪ (design visual adiado de propósito para o fim) |
| 2.11 Empacotamento e distribuição | ⚪ |

**2.8 (detalhes já decididos):** gateway de NFC-e ainda não escolhido (Focus NFe ou PlugNotas). Dois tipos de emissão
como no Linx: **NFC-e** (enviada à Fazenda) e **"Não Fiscal"** (mesmo cupom, sem envio). Entra a configuração fiscal
por produto (CFOP, CST/CSOSN, NCM, ICMS). Impressão de cupom térmico ESC/POS entra aqui.

**2.10:** referência visual Linx Degust, com liberdade para ser mais moderno; aceita refazer o CSS.

### Fase 3 — Licenciamento e cobrança: ⏸ ADIADA DE PROPÓSITO
Bloqueio real por `subscription_status` (RLS + tela de aviso): desenhado, não implementado, aguarda o PDV ficar pronto.

### Fase 4 — Preparação para comercializar: ⚪ NÃO INICIADA
Auditoria de segurança profissional, LGPD, backup, ambiente de staging.

---

## 6. Sub-fase 2.7 — estado detalhado

**Commit:** `e6f6deb` no branch `feat/2.7-split-payments` (inclui também 2.5 e 2.6, que nunca tinham sido commitadas).
**Migration:** `KanguruERP/supabase/migrations/20261008_pos_split_payments.sql` — **JÁ ESTÁ APLICADA** no Supabase ativo
(descoberto em 2026-10-14: as 3 tabelas, `check_pos_admin_password` e a versão de 15 parâmetros/retorno JSONB existem).
Provavelmente aplicada na sessão perdida de 10/10.
**Versão antiga removida (2026-10-14):** sobrava no banco uma `process_pos_terminal_sale` de 12 parâmetros (lógica da 2.5,
sem senha/auditoria, com GRANT para authenticated), recriada por reaplicação da 2.5 depois da 2.6. Removida pelo usuário
no SQL Editor com `20261014_drop_legacy_pos_terminal_sale.sql`; confirmado que só resta a versão de 15 parâmetros.

### Desenho aprovado
1. `sale_payments`: uma linha por forma de pagamento; `amount` = valor APLICADO (> 0); `installments` (só coluna, sem tela); mesmo método pode repetir.
2. `process_pos_terminal_sale` ganhou `p_payments JSONB DEFAULT NULL` e `p_admin_password TEXT DEFAULT NULL`; nulo = comportamento antigo. Agora **retorna JSONB** `{status: OK | INVALID_PASSWORD | LOCKED}`.
3. Soma das linhas = total **exata ao centavo**; em reserva, soma = saldo após o sinal.
4. Fechamento (`get_pos_cash_closure_summary`): vendas com linhas somam por `sale_payments` (sinal já descontado); vendas legadas usam `sales.payment_method` e subtraem `reservation_deposit_applied`. Nenhuma venda nos dois caminhos. Canceladas ficam fora.
5. Troco: só cálculo de tela, só sai da linha em dinheiro (`resolvePayments` em `KanguruPDV/src/app/App.tsx`).
6. Desconto acima de `max_item_discount_percent` exige senha administrativa; **o servidor recalcula** quais itens excedem. Reserva convertida nunca pede senha (desconto congelado).
7. Auditoria: `sale_discount_approvals` (item, % aplicado, limite vigente, terminal, data/hora).
8. Limite de tentativas: `check_pos_admin_password` (interna, sem GRANT) — 5 erros em 15 min bloqueiam; vale também para `unlock_pos_terminal` (que agora devolve zero linhas para senha errada). Histórico em `pos_admin_password_attempts`.
9. Decisões: **A2** 6 métodos no fechamento (DINHEIRO/PIX/CREDITO/DEBITO/VOUCHER/CREDIARIO), UI expõe 4; **B1** `sales.payment_method` = `'DIVIDIDO'` com 2+ linhas; **C1** senha vale para a venda inteira.
10. `process_sale_transaction` (venda do ERP web) **não foi alterada**.
11. ERP: Dashboard e Financeiro mostram "Dividido" e o detalhe por método; o estorno (`process_sale_cancellation`) não precisou mudar.

### Revisão (2026-10-13) — checklist
- ✅ Auditoria, limite de tentativas, sinal sem dupla contagem, troco separado, padrão de sessão de terminal, parâmetros opcionais.
- ⏳ **Falta conferir no Supabase ativo** antes de aplicar:
  - assinatura atual de `process_pos_terminal_sale` (a migration faz `DROP FUNCTION` pela assinatura exata de 13 parâmetros; se a do banco for outra, ficariam duas versões e o PDV quebraria);
  - se as tabelas `sale_payments` / `check_pos_admin_password` já existem (indicaria migration já aplicada);
  - todos os consumidores de `payment_method` (consulta 3 da seção 9).

### Pendências
- ~~Aplicar a migration~~ (já aplicada). ~~Remover a versão antiga de 12 parâmetros~~ (feito em 2026-10-14).
- Bundle Tauri não gerado (só `vite build`).
- Testes manuais: (a) 1 método, (b) 2–3 métodos, (c) soma divergente rejeitada, (d) desconto acima do limite com senha correta/errada/bloqueio, (e) reserva com sinal + pagamento dividido, (f) fechamento com vendas novas e legadas juntas sem dupla contagem, (g) estorno de venda dividida.
- Depois dos testes: PR de `feat/2.7-split-payments` para `main`.

---

## 7. Sub-fase 2.7b — Etiquetas, código de barras e custo por unidade

**Contexto:** hoje vendedores buscam produto por nome. Ideia: cada produto com código próprio, etiqueta impressa e colada,
vendedor bipa. Ex.: 5 cabos USB-C de marcas diferentes com o mesmo preço, hoje cadastrados como "cabos diversos".
Segundo problema: o mesmo produto tem **custos diferentes por compra** (cabos: R$1–3 de diferença; PS5: ~R$4.135 no
fornecedor vs ~R$4.320 numa compra urgente, vendido a ~R$4.900) e ele quer o lucro real.

### Decisões CONFIRMADAS
- Impressora: **Zebra GC420d** (pode variar por loja).
- Cada produto ganha código próprio + etiqueta; vendedor bipa.
- Ao salvar uma **entrada de estoque**, perguntar "imprimir N etiquetas?" (confirmação, nunca automático).
- Botão **reimprimir**; reimprimir quando o preço mudar (preço vai na etiqueta).
- Impressora desligada/sem papel → pedido fica **pendente** e imprime quando voltar.
- Conteúdo: nome, preço de venda, código do produto, código de barras e, se serializado, o serial (uma etiqueta por unidade).

### Propostas da IA AINDA NÃO CONFIRMADAS (reapresentar antes de implementar)
1. ERP grava pedido em tabela `print_jobs` (loja, conteúdo ZPL/dados, status); o PDV da loja consome, imprime em ZPL pelo **nome da impressora no Windows** e marca como impresso.
2. Duas impressoras por terminal: etiquetas (ZPL) e cupom (ESC/POS, 2.8), cada uma com seleção por nome, status e botão de teste. Fila espera o PDV estar aberto.
3. Leitor de código de barras = teclado USB (digita + Enter) no PDV e no ERP. Testar seriais com letras/símbolos (layout de teclado).
4. Cabos/itens baratos: cada marca vira produto próprio; custo por **média ponderada** a cada entrada.
5. Itens caros/serializados: **custo de compra em cada unidade** (`product_serial_units`); lucro = preço − custo da unidade bipada.
6. **Custo congelado no item da venda** (verificar se o sistema já faz isso).
7. ERP: margem por venda/produto/período; "Entrada de Estoque" passa a pedir custo (por unidade nos serializados).

### Perguntas em aberto ao usuário
- PS5 entram com serial lido na entrada ou só como quantidade?
- A Zebra fica no mesmo computador do PDV de cada loja?
- Tamanho da etiqueta?

Primeiro passo prático quando a Zebra chegar: teste de impressão ZPL a partir do Windows/PDV.

---

## 8. Pendências e ideias em aberto (não bloqueantes)

1. **Terminologia/UX:** renomear "SKU" para "Código" na interface; leitor preenchendo o campo; código automático a partir de `10100` quando o franqueado esquecer.
2. **Limite de desconto por produto** (hoje só por loja) — adiado para a refeita do cadastro de produto (concorrente tem "Limite de Desconto (%)" por produto).
3. **"Grupos Restritos" / senha "Gestor":** no ERP > Configurações, cada grupo de telas do PDV (cores estilo Degust: verde=venda, azul=caixa, roxo=configuração) pode ser ativado; ativado, exige senha "Gestor" (diferente da administrativa). Cada vendedor tem permissões individuais; ação fora do permitido pede a senha Gestor.
4. Referências do Linx já coletadas: venda com código de cliente (rastreio de garantia), pagamento dividido com parcelamento no crédito e desconto/acréscimo por linha (R$ ou %), NFC-e vs Não Fiscal.
5. Lacunas futuras (loja de games/PC): garantia/assistência técnica (RMA), NF-e além de NFC-e, ICMS-ST por categoria, compra/venda de usados e trade-in (com CPF do vendedor), variações e kits, marketplaces, CRM/fidelidade, aprovação para cancelamento/estorno.
6. Estorno de venda após o caixa fechado: comportamento no fechamento ainda não foi discutido.

---

## 9. Consultas úteis (SQL Editor do Supabase, uma por vez)

```sql
-- Funções/tabelas da 2.7: assinaturas e se a migration já foi aplicada
select proname, pg_get_function_identity_arguments(oid), pg_get_function_result(oid)
from pg_proc
where pronamespace='public'::regnamespace
  and proname in ('process_pos_terminal_sale','unlock_pos_terminal','get_pos_cash_closure_summary','check_pos_admin_password')
union all
select table_name, 'TABELA', '' from information_schema.tables
where table_schema='public' and table_name in ('sale_payments','sale_discount_approvals','pos_admin_password_attempts');
```

```sql
-- Colunas de uma tabela (troque 'sales')
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='sales'
order by ordinal_position;
```

```sql
-- Constraints de uma tabela
select conname, pg_get_constraintdef(oid)
from pg_constraint where conrelid='public.sales'::regclass;
```

```sql
-- Funções e views que usam payment_method
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
where p.pronamespace='public'::regnamespace and p.prosrc ilike '%payment_method%'
union all
select table_name, 'VIEW' from information_schema.views
where table_schema='public' and view_definition ilike '%payment_method%';
```

```sql
-- Código-fonte vivo de uma função
select pg_get_functiondef('public.process_pos_terminal_sale'::regproc);
```

---

## 10. Armadilhas já aprendidas (não repetir)

1. Nunca presumir nome de coluna/tipo/função: confirmar no schema real.
2. Não misturar validação de usuário do ERP com validação de sessão de terminal (seção 3).
3. Ao investigar um "bug", primeiro descartar confusão de loja/terminal/tenant ativo (aconteceu várias vezes).
4. Não pular a aprovação do desenho antes de implementar.
5. Mudanças em RPCs de produção devem ser aditivas. Ao mudar tipo de retorno, é preciso `DROP FUNCTION` pela assinatura exata — confira a assinatura no banco antes, senão sobra uma versão duplicada.
6. Ao trocar de ferramenta/sessão, recontextualizar e conferir o repositório antes de agir.
7. **Commitar ao fim de cada etapa.** Em 2026-10-13 descobrimos que as fases 2.5–2.7 inteiras nunca tinham sido commitadas (só existiam no HD).
8. Senha nunca em log, mensagem de erro ou console.

---

## 11. Como começar cada sessão

1. Ler este arquivo inteiro.
2. Rodar `git status`, `git branch` e `git log --oneline -10` e comparar com as seções 5, 6 e 12.
3. Se houver arquivos alterados e não commitados que não estão explicados na seção 12, **perguntar ao usuário** antes de mexer.
4. Seguir o fluxo da seção 2.

## Como encerrar cada etapa

1. Atualizar as seções 5, 6/7 e 12 deste arquivo.
2. Commit no branch da fase (nunca direto na `main` sem o usuário pedir) e, com aprovação, `git push`.

---

## 12. Diário de sessões (mais recente primeiro)

- **2026-10-14** — Consulta da seção 9 rodada: a migration da 2.7 **já está aplicada**. Sobrou no banco uma versão antiga de 12 parâmetros de `process_pos_terminal_sale` (ver seção 6). Confirmado que o código vivo é o revisado (senha, auditoria, DIVIDIDO). Versão antiga removida pelo usuário. Detalhes que só existiam no Handoff v4 incorporados aqui; os handoffs ficam obsoletos. Próximo passo: testes manuais (a)–(g).

- **2026-10-13** — Sessão perdida após o handoff v3 investigada: os arquivos da 2.7 foram editados em 10/10 por volta das 17h e nada depois disso. Revisão da 2.7 feita: auditoria e limite de tentativas já tinham sido implementados; falta só conferir o banco ativo. Criado o branch `feat/2.7-split-payments` com commit `e6f6deb` (2.5 + 2.6 + 2.7). Criado este `CLAUDE.md`. Próximo passo: usuário rodar as consultas da seção 9 e colar o resultado; depois aplicar a migration (com aprovação) e testar (a)–(g).
- **2026-10-10** — Sessão (perdida) implementou e corrigiu a 2.7. Handoff v3 escrito.
