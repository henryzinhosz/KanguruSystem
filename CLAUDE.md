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
| 2.7 Pagamento dividido + aprovação de desconto | ✅ Aplicada, testada e na `main` (PR #1, 2026-10-17) |
| 2.7b Etiquetas, código de barras e custo por unidade | 🟡 Parte 1 (custo/lucro/Dashboard) ✅ testada e na `main`. Parte 2 (código de barras) ✅ migration 20261018 aplicada e testes aprovados (2026-10-19). Parte 3 (Zebra) aguarda impressora (seção 7) |
| 2.8 Finalização da venda (fiscal, garantia) | ⚪ Não iniciada |
| 2.9 Trocas e devoluções | ⚪ |
| 2.10 Interface para tablet | ⚪ (design visual adiado de propósito para o fim) |
| 2.11 Empacotamento e distribuição | ⚪ |

**2.8 (detalhes já decididos):** gateway de NFC-e ainda não escolhido (Focus NFe ou PlugNotas). Dois tipos de emissão
como no Linx: **NFC-e** (enviada à Fazenda) e **"Não Fiscal"** (mesmo cupom, sem envio). Entra a configuração fiscal
por produto (CFOP, CST/CSOSN, NCM, ICMS). Impressão de cupom térmico ESC/POS entra aqui.

**2.10:** referência visual Linx Degust, com liberdade para ser mais moderno; aceita refazer o CSS.
**2.10 — modelo de MULTI TELAS (pedido do usuário em 2026-10-24, referência: prints do Linx Degust 5.9):** hoje o PDV tem
só 3 telas (abertura de caixa, venda, fechamento) e informação demais na de venda. Reorganizar assim:
- **Menu inicial em mosaico de botões grandes coloridos** por grupo (estilo Degust): verde = venda (Balcão/Nova venda,
  Cliente, Reservas, Garantia, Nota Fiscal), azul = caixa (Suprimento, Sangria, Abrir gaveta), laranja = Operacional
  (abertura, fechamento, caixa parcial/diário, reimpressões), vermelho = Consultas/Relatórios, roxo = Configurações e
  Cadastros, Comunicação, Trocar usuário. Barra superior fixa: PDV nº, data do caixa, abertura nº, operador, hora.
- Botões de grupo abrem **sub-menu em janela** com opções numeradas (ex.: "Operacional" e "Consultas/Relatórios").
- **Venda em sequência de telas:** (1) tela de lançamento — itens à esquerda com total, produtos/categorias no centro e à
  direita, botões de ação embaixo com atalhos (F2 código/nome, F5 finalizar, F6 cancelar, Esc sair); (2) **Finalizar
  venda** — formas de pagamento em grade + teclado numérico + atalhos de valor, resumo (subtotal, desconto, total, pago,
  troco); (3) **Identificar consumidor** (CPF/CNPJ/estrangeiro, nome) antes de concluir.
- Tudo usável no toque (tablet) e por teclado. Liga com o item 3 da seção 8 (Grupos Restritos/senha Gestor por grupo).
- Não implementar agora: fica para a 2.10 (ou antes, se o usuário pedir).

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
- ✅ Testes manuais aprovados pelo usuário em 2026-10-14: (a) 1 método, (b) 2–3 métodos, (c) soma divergente rejeitada, (d) desconto acima do limite com senha correta/errada/bloqueio, (e) reserva com sinal + pagamento dividido, (f) fechamento com vendas novas e legadas juntas sem dupla contagem, (g) estorno de venda dividida.
- ✅ Na `main` via PR #1 (junto com a 2.7b Parte 1 e vendedores), 2026-10-17.

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

### Respostas do usuário (2026-10-14)
- PS5 entram **com serial lido** na entrada.
- A Zebra fica **no mesmo computador do PDV** de cada loja.
- Tamanho da etiqueta: **ainda não definido** (etiquetas não compradas).

### Decisões de 2026-10-14
- Ordem aprovada: **Parte 1 custo/lucro → Parte 2 código de barras → Parte 3 etiquetas** (quando Zebra/etiquetas chegarem).
- Média ponderada para itens sem serial: **aprovada**.
- Código de barras do fabricante: **NÃO** — sempre etiqueta própria (código de fábrica vem errado/rasurado às vezes).
- Dashboard (junto da Parte 1), pedido do usuário: cards na ordem Faturamento Bruto | Lucro Bruto (fat. − custo) |
  Lucro Real Operacional (lucro bruto − taxas − custos) | Ticket Médio. "Itens em Alerta" vira painel no lugar do
  gráfico de categorias: lista de produtos com selo amarelo (médio risco) / vermelho (alto risco), contagem no subtítulo,
  "Níveis de estoque normais" no rodapé. "Faturamento por Categoria" vai para o lado do "Comparativo entre Lojas", que
  vira gráfico de linhas (referência: linhas em zigue-zague subindo, estilo profissional) mantendo a função de comparar lojas.
- Cabos "diversos" com preços variados: **cada faixa de preço vira um produto** (sem "preço livre", evita desvio).
- Lucro Real Operacional = lucro bruto − taxas − **despesas lançadas no Financeiro** (opção A). O "custo fixo" da loja
  fica só como meta do ponto de equilíbrio no gráfico diário (usuário lança os custos reais no Financeiro).
- Filtro de período no Dashboard: **aprovado** (Hoje / 7 dias / Este mês (padrão) / Mês passado / Personalizado).
- Corrigir junto: fuso horário das datas, "cobertura 30 dias" que usa tudo, texto fixo "3 lojas", ano 2026 fixo.
- Vendas antigas sem custo: **sem estimativa** — os dados atuais são de teste; o usuário vai **zerar o banco inteiro**
  (cadastros, PDVs ativos etc.) antes de usar de verdade. Zerar exige plano próprio e aprovação explícita.
- Itens em Alerta (aprovado): campo **estoque mínimo por produto** (padrão 2) + **dias de cobertura** (vendas dos
  últimos 30 dias). 🔴 alto = zerado ou cobre < 7 dias; 🟡 médio = ≤ mínimo ou cobre < 15 dias; mostra o motivo.
  Alerta **por loja**, com **seletor de loja próprio no card** (mostra só a loja escolhida). Ignora produto zerado sem
  venda há 90+ dias e sem mínimo definido. Números 7/15/30/90 são iniciais (usuário não contestou).

### Desenho APROVADO da Parte 1 — custo e lucro real (2026-10-15)
Branch: `feat/2.7b-custos` (criado a partir de `feat/2.7-split-payments`, que ainda não foi para a `main`).
1. **Custo médio POR LOJA** (não único): nova tabela de custo por produto+loja, com RLS. `products.cost_price` fica só
   como referência/padrão. Motivo: média única distorce o lucro por loja (exemplo do usuário: Loja 1 R$11,00 vs Loja 2
   R$12,09, média única R$11,43).
2. Entrada sem serial: **nova RPC atômica** (produto, quantidades por loja, custo unitário) que recalcula a média
   ponderada de cada loja que recebeu; estoque ≤ 0 → custo novo vira a média. Custo **obrigatório**.
   A antiga `process_inventory_movement` continua para transferência/perda/ajuste (corrigir o loop não atômico do ERP).
3. Saídas (perda, ajuste) **não mudam** a média. **Transferência leva o custo da loja de origem** e recalcula a média
   da loja de destino.
4. Serializados: `product_serial_units.unit_cost` (custo por unidade na entrada, com "aplicar a todas").
5. `movements.unit_cost`: histórico de custo de cada compra.
6. `products.min_stock` (nulo = não definido → usa 2) para os alertas.
7. **Custo congelado no item da venda** (PDV e ERP): sem serial = média da loja no momento; com serial = custo das
   unidades vendidas; serviço = 0; reserva = custo no momento da conversão (serial = unidade reservada).
   Assinaturas e retornos das RPCs de venda **inalterados** (PDV não muda).
8. Estorno devolve as unidades com o custo congelado na venda (recalcula a média da loja).
9. Custo só no ERP; PDV nunca mostra custo.
10. Seletor de loja (Consolidado = soma das lojas): Dashboard (cards, gráfico diário, categorias), **DRE Semanal do
    Financeiro** (ganha seletor + linha "custo das mercadorias vendidas"), Cadastro de Produto (custo por loja).
    Usuário de loja única vê só a própria loja.
11. Dashboard conforme "Decisões de 2026-10-14".

### Implementação da Parte 1 (2026-10-16) — migration APLICADA em 2026-10-16 (conferida; md5 novo da função do PDV: 3e5d76b864f9c9bf962bab76ad68259b)
- Migration `KanguruERP/supabase/migrations/20261015_product_costs.sql`: tabela `product_store_costs` (RLS leitura por
  loja), colunas `product_serial_units.unit_cost`, `movements.unit_cost`, `products.min_stock`; funções internas
  `inventory_with_unit`, `get_store_avg_cost`, `apply_store_cost_entry` (sem GRANT); nova RPC `register_stock_entry`
  e `list_product_store_costs`; `CREATE OR REPLACE` (mesma assinatura/retorno) de `register_serialized_stock_entry`,
  `process_inventory_movement`, `process_sale_transaction`, `process_sale_cancellation`, `process_pos_terminal_sale`.
  A cópia da função do PDV foi comparada linha a linha com a 20261008: só entraram as linhas de custo.
- **Antes de aplicar:** conferir que a função do PDV no banco é a da 20261008:
  `select md5(prosrc) from pg_proc where proname='process_pos_terminal_sale';` → esperado `3716cf738da0e77da44358b841ca094c`
  (CRLF) ou `f511cf62b7fb7d9c5448a934ebd3cac9` (LF). Se não bater, PARAR.
- **Ordem de publicação:** aplicar a migration ANTES de publicar o ERP novo (o ERP grava `min_stock`).
- ERP: `src/db/finance.ts` (regras únicas de período/custo/lucro para Dashboard e Financeiro), Dashboard reescrito,
  Financeiro (Indicadores) com seletor de loja, cards do mês e DRE com custo; Estoque com custo na entrada, custo por
  loja no cadastro e estoque mínimo editável. Estorno pendente agora só muda o status (`updateSaleStatus`), sem
  regravar os itens. PDV não mudou.
- Achados registrados (não corrigidos): abas "Transferências" e "Garantias" do Estoque sem botão na tela; trade-in de
  produto serializado falha no banco (usa a entrada antiga); venda manual do Financeiro não tem itens (sem custo).

### Investigação do código (2026-10-14, só repositório — confirmar no banco ativo antes de implementar)
- `products.cost_price`: um único custo por produto, definido no cadastro. A Entrada de Estoque **não pede custo**.
- `product_serial_units`: sem coluna de custo (serial, imei, status, garantia, sale_id).
- Venda do PDV grava em `sales.items` (JSONB) `unitPrice`, `itemSku`, `itemName` — **custo NÃO é congelado**.
- "Lucro Real" do Dashboard = faturamento − taxas − despesas: **ignora o custo da mercadoria**.
- Não existe campo de código de barras separado do SKU.

Primeiro passo prático quando a Zebra chegar: teste de impressão ZPL a partir do Windows/PDV.

### Parte 2 — código de barras (desenho APROVADO e implementado em 2026-10-18; migration `20261018_item_codes.sql` APLICADA e testes aprovados pelo usuário em 2026-10-19)
Decisões: "SKU" vira **"Código"** nas telas (coluna `sku` continua no banco); **uma numeração só** para produtos e
serviços do tenant; código só **letras, números e hífen**, maiúsculo, até 30; código em branco → banco gera o próximo
número a partir de **10100**; código do fabricante não é usado (decisão de 2026-10-14). Teste com leitor físico fica
para quando o usuário tiver o leitor em mãos (junto com a Zebra) — por ora testar digitando + Enter.
- Migration: trigger `zz_item_code_trigger` (função `enforce_item_code`, sem GRANT) em `products` e `services` —
  normaliza, valida, gera o número (lock por tenant) e impede código repetido entre as duas tabelas; não revalida código
  antigo quando só outro campo muda (inclusive no upsert do ERP). Prefixo `zz_` = roda depois do trigger de tenant.
  `next_item_code_for_tenant` (interna), `get_next_item_code()` (ERP, mostra o próximo), `find_pos_serial_unit(p_code)`
  (PDV, sessão de terminal; serial ou IMEI → unidade da loja; status DISPONIVEL/VENDIDO/RESERVADO/PERDIDO/OUTRA_LOJA).
  Nenhuma RPC de venda/reserva/caixa/estorno mudou. `search_pos_items` não mudou (md5 vivo 9daace98573cb66bab656122be988433).
- ERP: cadastro de produto e de serviço com Código opcional ("Automático: 10105"), erro do banco aparece na tela (antes o
  cadastro de produto falhava em silêncio); Entrada de Estoque: código exato + Enter seleciona o produto; Enter no
  serial pula/cria a próxima linha. Regra no front: `src/db/itemCode.ts`.
- PDV: código exato → carrinho (já existia); senão tenta serial/IMEI → unidade direto no carrinho ou aviso do motivo.
  O PDV novo funciona mesmo antes da migration (a consulta extra falha em silêncio).

### Encomenda (reserva sem estoque) + voucher de reserva + busca com sem-estoque (desenho APROVADO 2026-10-23; migration `20261023_reservation_backorder_voucher.sql` NÃO aplicada)
Decisões do usuário: busca mostra produto zerado com **"Sem estoque"** em vermelho e **"Possui estoque: <lojas>"** (só nomes);
produto sem estoque **pode ser reservado** (encomenda — vendem antes de a mercadoria chegar); voucher impresso **ao criar a
reserva**, A4 com via da loja (assinatura) + canhoto do cliente; valor: pagou tudo → só o valor; pagou parte → "Valor: X
(Restante: Y)"; nada → "R$ 0,00 (Restante: total)", forma "A pagar na retirada"; NF só quando a reserva vira venda (2.8);
data de retirada prevista = prazo da reserva; logo é única da rede (por ora texto "BeB GAMES"; **pedir o arquivo do logo**);
regras do voucher editáveis por loja no ERP (texto padrão da foto). CPF **obrigatório** na reserva (recomendação aceita por
omissão — usuário pode mudar).
- Achado corrigido junto: a `search_pos_items` viva era a da 2.5 (não descontava reservas ativas).
- Migration: `product_reservations.customer_cpf`, `product_reservation_items.is_backorder`, `store_configs.reservation_voucher_terms`;
  `pos_store_available_qty` (interna) = estoque − linhas ativas sem unidade; `search_pos_items` (DROP+CREATE, retorno ganha
  `stores_with_stock`); `get_pos_store_profile()`; `reserve_pos_cart` 7→8 parâmetros (`p_customer_cpf`, item `backorder`);
  `list_pos_reservations` com CPF, `isBackorder`, `isSerialized`; `process_pos_terminal_sale` (mesma assinatura): linha de
  encomenda com serial recebe na entrega a unidade escolhida (`item.serialUnitId`, precisa estar DISPONIVEL) e grava a unidade na
  reserva. Funções copiadas da 20261017 por script e comparadas (diff só com os trechos novos).
- Encomenda sem serial: quantidade fica segurada automaticamente quando a mercadoria chega. Com serial: unidade escolhida na
  entrega (protege só na busca; vender o serial bipado direto ainda é possível — avisar o usuário se virar problema).
- PDV: `src/app/reservationVoucher.ts` (impressão), CPF com validação, "Reimprimir voucher" na lista, seleção de serial na conversão.
- **Aplicar a migration, PDV e ERP juntos** (PDV antigo deixa de reservar; ERP novo grava `reservation_voucher_terms`).

### Clientes + consulta de garantia no PDV (desenho APROVADO 2026-10-24; migration `20261024_customers_warranty.sql` NÃO aplicada — depende da 20261023)
Decisões: cliente **sempre opcional** na venda; cadastro único por franqueado com código automático; campos: CPF (único,
validado), nome, celular, consentimento LGPD (obrigatórios), e-mail, CEP, endereço, número, complemento, bairro, cidade, UF,
observação (opcionais) — **sem** data de nascimento, pai/mãe, sexo, CSOSN, crédito bloqueado; CEP preenche endereço via
**ViaCEP**; no PDV o vendedor cadastra e corrige contato/endereço, **CPF e nome só no ERP**; consulta de garantia no PDV
(pedido do usuário; desenho da IA: busca por serial/IMEI/CPF, qualquer loja do tenant, "garantia até" + selo).
- Migration: `is_valid_cpf`, tabela `customers` (RLS ERP, triggers de tenant e `zz_customer_fields_trigger`: normaliza,
  valida, código sequencial com lock), `sales.customer_id`/`product_reservations.customer_id` preenchidos por trigger a partir
  do CPF já gravado (nenhuma RPC de venda/reserva mudou), RPCs `search_pos_customers`, `save_pos_customer`, `find_pos_warranty`.
- PDV: bloco "Cliente (opcional)" no carrinho (lista/cadastro/edição), venda envia `clientCpf/clientName` (parâmetros já
  existentes), conversão envia o CPF da reserva, Reservar pré-preenche com o cliente, botão **Garantia** no topo
  (`src/app/CustomerModals.tsx`, `WarrantyPanel.tsx`, `cpf.ts`, `services/supabase/customers.ts`).
- ERP: menu **Clientes** (`ClientesView.tsx`): lista, busca, cadastro/edição completa, histórico de compras com garantia.
- Voucher refeito no layout da foto (2026-10-24) com o logo (`KanguruPDV/src/assets/beb-games-logo.png`, fundo removido por
  script a partir do print; pedir arquivo original em alta se a impressão ficar serrilhada).

---

### Vendedores no PDV + relatórios do Histórico de Vendas (desenho de 2026-10-16)
Decisões do usuário:
- Código de vendedor **obrigatório** em toda venda (sem código não finaliza) e **obrigatório no cadastro** do vendedor.
- Código de **2 dígitos** (01 a 99). Único por **tenant + loja** (mesmo código pode existir em lojas diferentes e em
  franqueados diferentes, nunca dois iguais na mesma loja). Vendedor com código precisa ter loja.
- **Reserva convertida: a venda fica com quem INICIOU a reserva** (comissão de quem convenceu o cliente).
- Código identifica, não é senha (aceito pelo usuário).
- Venda guarda código e nome do vendedor do momento (congelado). Vendas antigas: sem vendedor.
- Histórico de Vendas: coluna Vendedor entre Data e Fatura/Doc; seletores Data (Hoje/Esta semana/Personalizado),
  Loja (Consolidado/loja) e Relatório (Simplificado / Analítico / Detalhado); estornadas fora dos totais.
- Dados atuais serão apagados, então vendedores antigos sem loja/código não são problema.
- Conversão de reserva: quem finaliza **também digita o código** (opção A) → gravado em `finalized_by_*`; a venda continua do vendedor da reserva.
- **Implementado em 2026-10-17 (migration `20261017_pos_sellers.sql` APLICADA pelo usuário em 2026-10-17; roteiro de testes de vendedores e impressão do histórico APROVADO pelo usuário):** `pdv_operators.code` + índice único (tenant, loja, código) entre ativos; colunas de vendedor em `sales` e `product_reservations`; `resolve_pos_seller` (interna), `find_pos_seller` (PDV confere o nome); `reserve_pos_cart` 6→7 parâmetros, `list_pos_reservations` com vendedor, `process_pos_terminal_sale` 15→16 parâmetros (status `INVALID_SELLER`). Corpos copiados das versões vivas (md5 conferido 2026-10-16) e comparados linha a linha. **Aplicar a migration e atualizar o PDV juntos**: o PDV antigo deixa de vender/reservar depois dela.

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

- **2026-10-15** — Desenho da Parte 1 da 2.7b aprovado (custo médio por loja, custo congelado na venda, novo Dashboard, DRE com seletor). Criado o branch `feat/2.7b-custos`.
- **2026-10-24** — Voucher no layout idêntico ao da foto, com logo. Clientes (PDV + ERP) e consulta de garantia no PDV implementados (migration 20261024). Builds ok. Pendente: md5 da 20261023, aplicar 20261023 e depois 20261024, testar.
- **2026-10-23** — Encomenda + voucher de reserva + busca com produtos sem estoque: desenho aprovado e implementado (migration 20261023 + PDV + ERP; builds ok; prévia do voucher conferida). Próximo passo: usuário conferir md5 das funções, aplicar e testar; enviar o arquivo do logo.
- **2026-10-19 (2)** — Usuário aplicou a 20261018 e aprovou todos os testes da Parte 2 e dos campos de valor. Novo pedido em desenho: busca do PDV mostrar produtos sem estoque com "Sem estoque" em vermelho.
- **2026-10-19** — Campos de valor padronizados (pedido e desenho aprovados pelo usuário): componente `ValueInput` (ERP `src/components/ValueInput.tsx`, PDV `src/app/ValueInput.tsx`) em todos os campos de dinheiro/percentual/quantidade (19 no ERP, 6 no PDV): começa vazio com dica "0,00", sem setinhas, **só vírgula** como decimal (ponto é ignorado, decisão do usuário), máx. 2 casas, sem zero à esquerda, vazio = 0; quantidades só inteiros. Sem mudança no banco. Resolvido também: tela branca no PDV em modo dev era cache antigo do WebView (DevTools > Rede > Desativar cache). Usuário confirmou que apagou `KanguruPDV/.env.example` (era modelo vazio).
- **2026-10-18** — 2.7b Parte 2 (código de barras) aprovada e implementada no branch `feat/2.7b-codigo-barras` (migration 20261018 + ERP + PDV; builds ok). Próximo passo: usuário conferir os triggers (consulta enviada), aplicar a migration com aprovação e testar. `KanguruPDV/.env.example` aparece apagado no git sem explicação — perguntado ao usuário, fora do commit.
- **2026-10-17 (4)** — PR #1 (`feat/2.7b-custos`, que contém 2.5–2.7, 2.7b Parte 1, vendedores e impressão do histórico) **mergeado na `main`** pelo usuário. Criado o branch `feat/2.7b-codigo-barras` a partir da `main` para a 2.7b Parte 2. Próximo passo: investigar e propor o desenho da Parte 2.
- **2026-10-17 (3)** — Usuário concluiu e aprovou todo o roteiro de testes dos vendedores no PDV (venda com código certo/errado/sem código, reserva iniciada e finalizada por vendedores diferentes, mesmo código em lojas diferentes, relatórios do histórico). Próximo passo: levar `feat/2.7b-custos` (que já contém a 2.7) para a `main`, com aprovação.
- **2026-10-17 (2)** — Botão **Imprimir** no Histórico de Vendas (aprovado): imprime/salva PDF do que está filtrado (Data, Loja, Relatório), com cabeçalho (empresa, loja, período, quem imprimiu), sem menu/botões/coluna Ações; Detalhado em A4 paisagem. Arquivo `KanguruERP/src/components/historyPrint.ts`. Sem mudança no banco. Usuário concluiu e pediu para voltar ao cronograma.
- **2026-10-17** — Vendedores no PDV implementados (migration 20261017 + PDV + ERP: cadastro com código, Histórico de Vendas com Data/Loja/Relatório Simplificado-Analítico-Detalhado e coluna Vendedor). Builds do ERP e do PDV ok. Próximo passo: aplicar a migration (com aprovação) e testar.
- **2026-10-16 (3)** — Usuário aplicou a 20261016 e aprovou todos os testes da Parte 1. Novo pedido em desenho: filtros/relatórios do Histórico de Vendas (Data, Loja, Simplificado/Analítico/Detalhado), coluna Vendedor e **código de vendedor no PDV** (único por tenant+loja).
- **2026-10-16 (2)** — Ajustes pedidos nos testes: semanas como "Sem 01 - Out (01 a 04/10)"; DRE com seletor de mês/semana e total do mês; **decisão: vendas só pelo PDV** (removido o lançamento manual do Financeiro, que vira Histórico de Vendas/estorno); corrigido apagamento de formulários ao voltar para a janela (renovação do login). Migration `20261016_serial_entry_duplicate_message.sql` (mensagem de serial repetido) **ainda não aplicada**.
- **2026-10-16** — Parte 1 implementada (migration + ERP), `tsc` e `vite build` ok. Próximo passo: usuário conferir o md5 (seção 7), aplicar a migration com aprovação e testar o roteiro da Parte 1.

- **2026-10-14** — Consulta da seção 9 rodada: a migration da 2.7 **já está aplicada**. Sobrou no banco uma versão antiga de 12 parâmetros de `process_pos_terminal_sale` (ver seção 6). Confirmado que o código vivo é o revisado (senha, auditoria, DIVIDIDO). Versão antiga removida pelo usuário. Detalhes que só existiam no Handoff v4 incorporados aqui; handoff apagado. Branch enviado ao GitHub. **Testes (a)–(g) da 2.7 passaram todos.** Próximo passo: PR de `feat/2.7-split-payments` para `main` (com aprovação) e depois retomar o desenho da 2.7b (seção 7).

- **2026-10-13** — Sessão perdida após o handoff v3 investigada: os arquivos da 2.7 foram editados em 10/10 por volta das 17h e nada depois disso. Revisão da 2.7 feita: auditoria e limite de tentativas já tinham sido implementados; falta só conferir o banco ativo. Criado o branch `feat/2.7-split-payments` com commit `e6f6deb` (2.5 + 2.6 + 2.7). Criado este `CLAUDE.md`. Próximo passo: usuário rodar as consultas da seção 9 e colar o resultado; depois aplicar a migration (com aprovação) e testar (a)–(g).
- **2026-10-10** — Sessão (perdida) implementou e corrigiu a 2.7. Handoff v3 escrito.
