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
| 2.8 Finalização da venda (fiscal, garantia) | 🟡 Emissor escolhido: **Focus NFe**. 2.8a ✅ aplicada e testada em 2026-10-27 (PC da loja, instalador 0.1.1). **2.8b NFC-e** ✅ aplicada (migration 20261028, Edge Functions `nfce-emit`/`nfce-cancel` publicadas) e testada em **homologação** em 2026-10-27; DANFE no layout da Linx com logo BeB (instalador 0.1.4). Antes da produção: token de produção novo, tributos IBPT nos produtos, trocar ambiente no UCP. Contingência caso 1 + modo offline ✅ testados (exceto NFC-e sem internet: Comunicador adiado, exige plano pago). **2.8c impressão direta ✅ testada na loja em 2026-10-28** (Epson TM-T20, cupom/NFC-e em 2 vias, gaveta) |
| 2.9 Trocas e devoluções | ✅ Aplicada (migration 20261030, `nfe-return-emit` publicada) e **testada em 2026-10-28** (vale-troca, troca, dinheiro com senha, avariado, NF-e de devolução em homologação, fora do prazo, histórico); PDV 0.1.8 instalado pelo atualizador |
| 2.10 Interface para tablet | 🟡 Menu inicial + barra superior implementados em 2026-10-28 (protótipo aprovado; PDV 0.2.0); venda continua como hoje |
| 2.11 Empacotamento e distribuição | ⚪ |

**2.8 (detalhes já decididos):** emissor **Focus NFe** (aprovado 2026-10-26; plano Retail por CNPJ ou Retail+ ilimitado). Chave da Focus **por loja, configurada só no UCP** (franqueado vê só "configurada/não configurada"); certificado A1 e CSC ficam cadastrados **dentro da Focus**, nunca no nosso banco; a chave fica no servidor (Edge Function), nunca no PDV. Usuário já tem certificado e dados fiscais dos produtos principais.
**2.8a (desenho aprovado 2026-10-26, implementado 2026-10-27):** dados fiscais **produto a produto** como no sistema atual (opção A, sem padrão da loja): NCM (8 dígitos), CEST, Origem (lista oficial 0–8), CST (lista oficial, **sem o 28** que aparece no sistema atual — confirmar com contador), CSOSN (101…900), ICMS %, Redução ICMS %, Total de tributos %; sem CFOP/PIS/COFINS no produto (2.8b deriva). Formulário de produto agora também **edita** (lápis na lista) e mostra selo "SEM NCM". PDV: **dois botões** "NFC-e" (em breve) e "Não Fiscal" — vendedor escolhe em toda venda. Cupom 80 mm **igual ao cupom atual da rede** (DAV, sem "sem valor fiscal"), número **00001 por loja, recomeça todo mês** (trigger `zz_sale_receipt_number`, `sales.receipt_number/receipt_period`), QR code = **Instagram da loja** (campo na loja), frase de troca **fixa**; impressão pela impressora do Windows (Epson TM 80 mm na loja; pode variar). Migration `20261027_fiscal_products_receipt.sql`: colunas fiscais em `products`, `store_configs.instagram`, `sales.fiscal_type/fiscal_status/receipt_*`, `get_pos_store_profile` (DROP+CREATE com IE e Instagram), `get_pos_sale_receipt`. Função de venda **não mudou**. Lib `qrcode@1.5.4` no PDV. **Aplicar a migration antes de usar o ERP/PDV novos.**
Antes: gateway de NFC-e ainda não escolhido (Focus NFe ou PlugNotas). Dois tipos de emissão
como no Linx: **NFC-e** (enviada à Fazenda) e **"Não Fiscal"** (mesmo cupom, sem envio). Entra a configuração fiscal
por produto (CFOP, CST/CSOSN, NCM, ICMS). Impressão de cupom térmico ESC/POS entra aqui.

**2.8b (desenho aprovado 2026-10-27, implementado no mesmo dia):** Focus NFe, testes sempre em **homologação** primeiro. Usuário: Simples Nacional, CST/CSOSN conferidos pelo contador; certificado e CSC de homologação cadastrados **na Focus** (CSC nunca no nosso banco). Decisões: botão NFC-e do PDV ativo sempre que a loja tem a Focus configurada (a validação fiscal fica no **cadastro do produto no ERP: NCM, origem, CSOSN ou CST, ICMS %, redução, total de tributos obrigatórios; CEST obrigatório com ST**); serviços **ficam fora da nota** (nota só com produtos; pagamentos cortados no valor dos produtos, sinal primeiro); nota recusada → venda continua registrada, modal Tentar de novo / Imprimir Não Fiscal / Deixar pendente; cancelamento só no estorno do ERP até 30 min (depois bloqueia; devolução na 2.9). **Reimpressão (pedido do usuário):** botão impressora abre a tela "Cupons e notas" com busca por **Data / Número (cupom ou NFC-e) / CPF**, lista com Reimprimir e "Emitir NFC-e" para pendentes/erro. Banco (`20261028_nfce_focus.sql`): `store_fiscal_settings` (chave + ambiente por loja; RLS sem políticas e REVOKE: só service role), colunas `sales.nfce_*` + CHECK de `fiscal_status` (PENDENTE/AUTORIZADA/ERRO/CANCELADA), `sale_fiscal_events` (auditoria), RPCs `platform_set_store_focus`/`platform_clear_store_focus`/`platform_list_store_fiscal` (UCP), `list_store_nfce_status` (ERP), `get_pos_nfce_status`, `search_pos_sales`, `get_pos_sale_receipt` (CREATE OR REPLACE, + campos nfce; md5 vivo esperado 6609820642ef51683793a47cdc035562 LF / 97ba2571075ef60e6f071515343efc6f CRLF). Edge Functions em `supabase/functions/`: `nfce-emit` (sessão de terminal; monta o JSON da Focus: CFOP 5405 p/ CSOSN 500 ou CST 60, senão 5102; PIS/COFINS 49; pagamentos 01/03/04/05/10/17; ref = `<saleId>-<tentativa>`; consulta antes de reenviar pendente) e `nfce-cancel` (ERP; acesso conferido pela RLS de `sales`). PDV: DANFE NFC-e 80 mm em `receiptPrint.ts` (QR da Sefaz; homologação imprime "SEM VALOR FISCAL"), `ReceiptsPanel.tsx`; conversão de reserva com botões NFC-e/Não Fiscal. ERP: UCP com chave/ambiente por loja; Configurações mostra configurada/não; Histórico mostra NFC-e nº/situação/XML/DANFE; estorno cancela a NFC-e antes. **Layout do DANFE: usuário vai mandar foto do cupom NFC-e atual para deixar igual.**
**2.9 (desenho aprovado 2026-10-27):** devolução **parcial** pelo PDV (Cupons e notas › "Trocar / Devolver"), só na loja da venda. Cliente recebe: **TROCA** (vale usado na hora numa venda nova), **VALE** (vale-troca no CPF), **DINHEIRO**, **PIX**, estorno **CREDITO/DEBITO** (feito na maquininha). Prazo **7 dias** por loja (`store_configs.exchange_days`, editável no ERP); fora do prazo ou com dinheiro saindo exige **senha administrativa** (contexto `SALE_RETURN`); troca/vale sem senha. Produto volta ao estoque (custo congelado da venda, recalcula média) ou vai para **avariados** (`product_damaged_stock` / serial `AVARIADO`; aba "Avariados" no Estoque do ERP). Venda com NFC-e autorizada → **NF-e de devolução** (entrada, finalidade 4, **CFOP 1202** confirmado pelo contador, PIS/COFINS 99, pagamento 90, `notas_referenciadas` com a chave da NFC-e) pela Edge Function `nfe-return-emit` (assíncrona: envia e consulta); exige CPF + endereço completo do cliente (PDV abre o cadastro). Vale-troca = método **VOUCHER**: trigger `zz_sale_payment_voucher` debita os vales do CPF da venda (função de venda NÃO mudou); estorno de venda paga com vale devolve o saldo; venda com devolução não pode ser estornada (trigger `zz_sale_cancellation_returns`). Fechamento: `get_pos_cash_closure_summary` (cópia da 20261008 + CTE `return_refunds`; md5 vivo esperado 8c494f20ffbcd1cc448c69ab5c4b730d LF / 834a48052a5deeb7ff4528a5f2bc2423 CRLF) e `get_pos_cash_session_report` (md5 vivo c74dd9eca5a0f3e809330b9702c7bc51 / 78391f3976d20811e311274b18e5d2bf) com devoluções. ERP: Histórico mostra devoluções e esconde Estornar; Dashboard/DRE descontam devoluções **no período da venda** (simplificação). NFC-e: VOUCHER passa a código 05 (crédito loja) → **republicar `nfce-emit`**. Comprovante 80 mm `returnReceiptPrint.ts`. Para a NF-e: usuário precisa **ativar NF-e na Focus** (homologação, série/próximo número).
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
- Achados (corrigidos em 2026-10-28): aba Transferências ganhou botão e espera o banco; aba Garantias do ERP removida
  (consulta fica no PDV); trade-in virou **Troca Gamer** (só videogames, serial real, custo = valor pago, fiscal pré-preenchido
  NCM 9504.50.00 / origem 0 / CSOSN 102 / ICMS 0, CFOP 5102 automático). Venda manual do Financeiro foi removida (2026-10-16).

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

### Encomenda (reserva sem estoque) + voucher de reserva + busca com sem-estoque (desenho APROVADO 2026-10-23; migration `20261023_reservation_backorder_voucher.sql` APLICADA + `20261025_reservation_stock_ready.sql` APLICADA; testes aprovados 2026-10-25)
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

### Clientes + consulta de garantia no PDV (desenho APROVADO 2026-10-24; migration `20261024_customers_warranty.sql` APLICADA; testes aprovados 2026-10-25)
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
2. ~~Limite de desconto por produto~~ — **implementado em 2026-10-26** (migration `20261026_product_discount_limit.sql` APLICADA e testes aprovados em 2026-10-26): `products.max_discount_percent`; vale o do produto, sem limite próprio (e serviços) usa o **"Limite de desconto padrão (%)"** da loja; função interna `pos_item_discount_limit`; `search_pos_items`, `find_pos_serial_unit`, `reserve_pos_cart` e `process_pos_terminal_sale` (mesmas assinaturas) copiadas das versões vivas com só a troca do limite. md5 vivos esperados antes de aplicar: search b12c33ee…/76110d8f…, serial e0865691…/33765c94…, reserve 363f62d1…/59029b79…, sale 65cd750c…/b444aa6f…. **Aplicar a migration ANTES do ERP novo** (o ERP grava `max_discount_percent`). PDV mostra o limite em cada item do carrinho.
3. **"Grupos Restritos" / senha "Gestor":** no ERP > Configurações, cada grupo de telas do PDV (cores estilo Degust: verde=venda, azul=caixa, roxo=configuração) pode ser ativado; ativado, exige senha "Gestor" (diferente da administrativa). Cada vendedor tem permissões individuais; ação fora do permitido pede a senha Gestor.
4. Referências do Linx já coletadas: venda com código de cliente (rastreio de garantia), pagamento dividido com parcelamento no crédito e desconto/acréscimo por linha (R$ ou %), NFC-e vs Não Fiscal.
5. Lacunas futuras (loja de games/PC): garantia/assistência técnica (RMA), NF-e além de NFC-e, ICMS-ST por categoria, compra/venda de usados e trade-in (com CPF do vendedor), variações e kits, marketplaces, CRM/fidelidade, aprovação para cancelamento/estorno.
6. Estorno de venda após o caixa fechado: comportamento no fechamento ainda não foi discutido.
7. **Relatório Gerencial de Abertura de PDV (pedido do usuário em 2026-10-27; abertura, sangria e suprimento IMPLEMENTADOS em 2026-10-27 em `KanguruPDV/src/app/cashReportPrint.ts`, instalador 0.1.5; fechamento IMPLEMENTADO em 2026-10-27 no modelo adaptado da "Redução de caixa" do Degust (desenho aprovado: sem mesa/taxa de serviço/troco; com reservas convertidas, sinais, contado x diferença, suprimentos/sangrias, gaveta, NFC-e x Não Fiscal, estornos; 1 via; migration `20261029_pos_cash_report.sql` com a RPC só de leitura `get_pos_cash_session_report`, NÃO aplicada; instalador 0.1.6)):** ao abrir o caixa, imprimir um documento **exatamente** como a referência `KanguruPDV/docs/referencias/relatorio-abertura-caixa.png`: cabeçalho com nome da loja (negrito, centralizado), Telefone, CNPJ e IE; linha; "Data: dd/mm/aaaa hh:mm:ss"; título **RELATÓRIO GERENCIAL** (grande, negrito, centralizado) e subtítulo "Abertura de PDV"; "PDV: <caixa>" e "Operador: <responsável>" na mesma linha; "Dinheiro: R$ <fundo de troco>"; "Total: R$ <total>"; espaço para assinatura com linha e "ASSINATURA DO OPERADOR". Bobina 80 mm, mesma impressão do cupom (negrito, preto puro). Provável par natural: relatório de fechamento/sangria/suprimento no mesmo formato (perguntar antes).

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
- **2026-10-29 (3)** — Usuário aplicou a 20261103 e **aprovou todos os testes da Troca Gamer pelo PDV**. Pedido: relatório do caixa (parcial e fechamento) lista **cada sangria e suprimento** (hora, motivo, valor) depois de "Estornadas". Nova RPC só leitura `get_pos_cash_movements` (migration `20261104_pos_cash_movements.sql` **APLICADA**; usuário dispensou bloquear Troca Gamer em dinheiro acima da gaveta). PDV 0.2.7 publicado.
- **2026-10-29 (2)** — Usuário aprovou os testes da Troca Gamer no ERP. **Troca Gamer pelo PDV** (desenho aprovado: rodapé com assinatura do cliente + responsável da loja; valor em vale-troca **e** dinheiro/Pix; RG/CNH opcional): migration `20261103_troca_gamer_pdv.sql` (NÃO aplicada) com colunas novas em `trade_ins` (nº por loja, telefone, endereço, RG/CNH, serial, IMEI, itens, forma, vendedor), `store_configs.trade_in_terms`, `customer_credits.origin_trade_in_id`, contexto de senha `TRADE_IN_PAYOUT` e RPC `register_pos_trade_in` (cliente do cadastro, código do vendedor, serial repetido recusado, VALE = vale-troca, DINHEIRO = sangria "Troca Gamer nº X" + senha, PIX = senha). PDV 0.2.6: botão **Troca Gamer** (tecla 1) no menu, `TradeInPanel.tsx`, termo A4 em 2 vias `tradeInTermPrint.ts` (declarações editáveis por loja no ERP › Configurações), gaveta abre no dinheiro, "Usar o vale agora numa venda". ERP: formulário de avaliação saiu (registro só no PDV); lista com nº, serial, itens, telefone, RG, forma e vendedor; "Conferir e Estocar" já traz serial/IMEI. **Aplicar a migration antes do ERP novo** (ERP grava `trade_in_terms`).
- **2026-10-29** — Transferência com **busca** por código/nome/serial (pedido do usuário, no lugar do seletor). Bug antigo achado no teste: produto com serial transferido para loja que nunca teve o produto ficava 0 nas duas (`sync_serialized_inventory_quantity` legado usava jsonb_set sem criar a loja). Migration `20261102_fix_serial_inventory_sync.sql` (usa `inventory_with_unit` + recalcula todos os serializados) **APLICADA** após md5 conferido (f6997bea… CRLF); testes de transferência aprovados. Pendente: testes da Troca Gamer.
- **2026-10-28 (14)** — Erros antigos (desenho aprovado): Estoque com botão **Transferências** (só mostra sucesso se o banco confirmar, `registerTransfer`), aba **Garantias** do ERP removida; **Troca Gamer** (ex-Trade-In): só videogames, aprovação pede nome, código (automático), preço, garantia, **serial real** e IMEI; entrada por `register_serialized_stock_entry` com custo = valor pago; dados fiscais pré-preenchidos (NCM 9504.50.00, origem 0, CSOSN 102, ICMS 0, total de tributos 26,87%); erro aparece na tela e a troca só fica aprovada se tudo der certo (produto criado é reaproveitado ao tentar de novo). Migration 20261016 **já estava aplicada** (md5 vivo 82e90426…). Sem mudança no banco. Pendente: testes do usuário.
- **2026-10-28 (13)** — Usuário aprovou os testes da **impressão direta** (0.2.5): teste da impressora, cupom Não Fiscal e NFC-e direto em duas vias, gaveta automática no dinheiro e botão Abrir gaveta.
- **2026-10-28 (12)** — Pedido do usuário: cupom **sempre em duas vias** (loja e cliente), Não Fiscal ("VIA DA LOJA"/"VIA DO CLIENTE") e NFC-e ("Via Consumidor"/"Via Estabelecimento"), na impressão direta e na janela do Windows. PDV 0.2.5 publicado.
- **2026-10-28 (11)** — **2.8c impressão direta** (desenho aprovado; gaveta abre sozinha em venda com dinheiro; impressora escolhida pelo nome do Windows em cada PC, ESC/POS genérico porque o modelo varia por loja — loja usa Epson TM-T20): Rust `src-tauri/src/raw_printer.rs` (`list_printers`, `print_raw` via winspool RAW, `windows-sys 0.61`), `src/printing/escpos.ts` (48 colunas, PC860, QR GS(k, imagem GS v 0, corte, pulso de gaveta), `src/printing/directPrint.ts` (DAV e DANFE NFC-e em ESC/POS com logo/QR; contingência em 2 vias; fallback para a janela do Windows se falhar), `PrinterSettingsModal.tsx` (Menu › Configurações › Impressora, com Imprimir teste), botão Abrir gaveta no menu. Relatórios do caixa, comprovante de troca e voucher A4 continuam pela janela do Windows. PDV 0.2.4 publicado; pendente teste na loja.
- **2026-10-28 (10)** — Usuário confirmou: **vendas e sangria offline subiram normalmente** com a 0.2.3 (modo offline aprovado, exceto NFC-e sem internet). **Comunicador Offline adiado para o final** (exige plano pago da Focus). Próximo: resto do cronograma.
- **2026-10-28 (9)** — Testes do offline na loja: (1) 1ª tentativa sem migrations aplicadas → sem cópia local (sem produtos/caixa); usuário depois aplicou 20261031/20261101. (2) Envio falhou com "permission denied for function import_pos_offline_sale"/"Active terminal session required": PDV aberto **sem internet** nunca carregava a sessão do terminal → chamadas como anônimo. Corrigido: `ensureTerminalSession()` (getSession → refreshSession → `terminalAuth.restore()`) antes do envio e da cópia; erro de sessão não vira ERRO (volta a PENDENTE e reenvia sozinho, inclusive os já marcados). Faixa MODO OFFLINE foi para baixo (cobria a barra). Venda "NFC-e" offline saiu como Não Fiscal (Comunicador ainda não configurado). PDV 0.2.3 publicado.
- **2026-10-28 (8)** — Reservas: campo "Método da devolução manual" saiu do topo (aprovado); ao cancelar reserva **com sinal** abre janela "Como o sinal de R$ X foi devolvido?" (Dinheiro/Pix/Crédito/Débito); sem sinal só confirma. Rótulos com acento (Crédito/Débito/Crediário). Sem mudança no banco. PDV 0.2.2 publicado.
- **2026-10-28 (7)** — Ajustes pedidos nos testes da 0.2.0: botões dos cabeçalhos de Cupons e Reservas alinhados e espaçados; logo laranja da barra centralizado (CSS do texto pegava o ícone); **"Nova reserva" saiu do menu** (fica só em Reservas); atalhos renumerados (venda 2–5, caixa 6–9); aviso "Internet de volta" só aparece quando há vendas enviadas. PDV 0.2.1 publicado.
- **2026-10-28 (6)** — Protótipo do visual **aprovado** e levado ao PDV: tela `menu` (inicial depois de desbloquear/abrir caixa/sangria), `TopBar.tsx` (loja, PDV, data do caixa, abertura nº via `get_pos_cash_session_report`, operador, online/offline, hora), `HomeMenu.tsx` (mosaico pastel; F1 venda, 1–9 atalhos; sub-menus Operacional/Consultas/Configurações; Abrir gaveta e Impressora "em breve"), `ProductLookupModal.tsx` (consulta de produto e estoque), **Caixa parcial** (relatório de fechamento com `partial`, sem contagem). Venda: topo virou a barra com botão Menu (Esc volta ao menu; Esc limpa a busca antes). Telas Reservas/Garantia/Cupons/Sangria voltam ao menu. Sem mudança no banco. PDV 0.2.0 publicado pelo atualizador (inclui também contingência e modo offline, que dependem das migrations 20261031/20261101 ainda não aplicadas — sem elas o PDV funciona online normalmente).
- **2026-10-28 (5)** — 2.10 visual do PDV, decisões do usuário: **tela de venda continua como hoje** (sem sequência de 3 telas, sem grade de produtos: só busca e leitor); **cores atuais do Kanguru** (verde-escuro/laranja) e **tema claro**; **menu inicial com cores pastel** por grupo (verde venda, azul caixa, laranja operacional, vermelho consultas, roxo configurações) + barra superior fixa (PDV, data do caixa, abertura nº, operador, online/offline, hora) + sub-menus em janela numerada. Protótipo clicável (canvas) em https://claude.ai/artifact/XLE5ZtTKmMpBfuz6PUHtU2 (Menu inicial, Sub-menu Operacional, Venda com barra nova) aguardando aprovação.
- **2026-10-28 (4)** — Usuário pediu para **guardar o roteiro de aplicação/testes do offline** e reenviar quando pedir: está em `KanguruPDV/docs/roteiro-testes-offline.md`. Pausou os testes offline; pediu a lista de etapas restantes.
- **2026-10-28 (3)** — **Modo offline do PDV** (desenho aprovado; Focus confirmou o Comunicador Offline no plano, mesma ref na nuvem e simulação por cabo desligado). Banco `20261101_pos_offline.sql` (NÃO aplicada): `get_pos_offline_snapshot` (catálogo com preço/estoque/limite/fiscal, seriais disponíveis, vendedores, loja, caixa aberto, NFC-e), `import_pos_offline_sale` (idempotente pelo id; não recusa por estoque/serial/preço → `pos_offline_conflicts`; `sales.offline_origin`), `resolve_pos_offline_conflict` (ERP). PDV: plugin `tauri-plugin-sql` (SQLite `kanguru-offline.db`: kv + outbox), `src/offline/offline.ts` (cópia local, conexão a cada 20 s, fila, envio, hash PBKDF2 da senha para desbloquear sem internet), `src/offline/comunicador.ts` (NFC-e pela API local do Comunicador, porta configurável em Cupons e notas), `OfflineBanner.tsx`, `OfflineCustomerModal.tsx`; venda/sangria/suprimento offline; reservas, garantia, cupons, trocas, vale-troca, desconto acima do limite e fechamento bloqueados offline; fechamento só com tudo enviado; NFC-e offline até 24 h, senão Não Fiscal. **Corrigido risco antigo:** abrir o PDV sem internet apagava a sessão do terminal (`auth.ts` agora só limpa em recusa real). ERP: painel "Vendas sem internet com divergência" no Histórico. Pendente: aplicar 20261031 e 20261101, publicar funções, PDV 0.1.9, instalar Comunicador e testar.
- **2026-10-28 (2)** — Contingência da NFC-e **caso 1** (Sefaz fora do ar, internet ok; desenho aprovado): Focus emite em contingência automaticamente → `nfce-emit` grava `sales.nfce_contingency/nfce_contingency_done` e trata como AUTORIZADA; DANFE com "EMITIDA EM CONTINGÊNCIA / Pendente de autorização" em **duas vias** (consumidor + estabelecimento); nova Edge Function `nfce-contingency-sync` (PDV chama ao abrir e a cada 10 min; efetivada → done; recusada → ERRO + alerta para corrigir em 24 h); Cupons e notas e Histórico do ERP mostram "em contingência". Migration `20261031_nfce_contingency.sql` (colunas + `get_pos_sale_receipt`/`search_pos_sales` copiadas da 20261028; md5 vivos esperados receipt fe90c18b5920e935b46a44adb56f08e4 LF / e2c16ec23286125c00c4658ac01525cf CRLF, search 1df6344856403951953ebcbe89679dcb LF / 91ccf7038fcaa9ab5781e3f9469d36c8 CRLF) **NÃO aplicada**; republicar `nfce-emit`, publicar `nfce-contingency-sync`; PDV 0.1.9 a publicar depois. **Caso 2 (internet da loja caiu): usuário quer o MODO OFFLINE completo já** — desenho enviado para aprovação.
- **2026-10-28** — Usuário aprovou **todos os testes da 2.9** e o **atualizador automático** (0.1.7 → 0.1.8 pelo aviso). Próximo: contingência offline da NFC-e (2.8b parte 2) → ESC/POS (2.8c); sugerido PR de `feat/2.8-finalizacao` para a `main`.
- **2026-10-27 (9)** — 2.9: pré-checagens conferidas (md5 CRLF do fechamento e do relatório, constraints), usuário aplicou a 20261030, publicou `nfe-return-emit`, atualizou `nfce-emit` e ligou NF-e na Focus. **PDV 0.1.8 publicado pelo atualizador** (1º teste real do aviso). Pendente: testes da 2.9.
- **2026-10-27 (8)** — Usuário instalou a 0.1.7 no PC da loja e **aprovou os testes do caixa** (abertura, sangria, suprimento, fechamento com diferença; migration 20261029 aplicada). Próximo: desenho da 2.9 Trocas e devoluções.
- **2026-10-27 (7)** — **Atualização automática do PDV** (desenho aprovado: Supabase Storage bucket público `pdv-updates`; aviso "Atualizar agora / Depois"; "Depois" mostra alerta de que a versão antiga pode travar, com botão Fechar; nunca no meio de venda; checa ao abrir e a cada 4 h). Plugins `tauri-plugin-updater` + `tauri-plugin-process`, `src/app/UpdateNotice.tsx`, capabilities `src-tauri/capabilities/default.json`. **Chave de assinatura em `C:\Users\PC\.tauri\kanguru-pdv.key` (sem senha, FORA do Git) — precisa de backup; perdida = reinstalar PDVs à mão.** Publicar versão: aumentar `version` em `tauri.conf.json` e rodar `node scripts/release-pdv.mjs "notas"` em `KanguruPDV/` (gera instalador assinado, `release/latest.json` e envia ao bucket via CLI; usuário autorizou o CLI para isso). Bucket criado e CLI logado pelo usuário; **0.1.7 publicada** no bucket (latest.json + instalador conferidos por download). Script: CLI não sobrescreve (remove antes) e caminho relativo sem acento (cmd estraga o "ç"). Pendente: usuário instalar 0.1.7 à mão uma última vez; o 1º teste real do aviso será na 0.1.8.
- **2026-10-27 (6)** — Relatórios gerenciais do caixa: abertura/sangria/suprimento (modelo da foto) e fechamento (adaptado do Degust). Usuário aprovou A–D: próximos 2.9 trocas/devoluções → contingência offline → ESC/POS. Pendente: aplicar 20261029 e testar o fechamento.
- **2026-10-27 (5)** — Migration 20261028 aplicada (md5 conferido), Edge Functions publicadas (1ª tentativa ficou com slug quick-api/quick-worker: recriadas com o nome certo), ID Token do CSC corrigido na Focus. 1ª NFC-e autorizada em homologação. Corrigidos: regex da chave/CPF no DANFE; DANFE refeito no modelo do cupom fiscal da Linx com logo BeB (prévia por esbuild + Edge headless). Instaladores 0.1.3 e 0.1.4. Usuário aprovou os testes. Pedido registrado: relatório gerencial de abertura de caixa (seção 8 item 7).
- **2026-10-27 (4)** — 2.8b (NFC-e Focus) com desenho aprovado e implementada (ver seção 5); reimpressão por data/número/CPF; dados fiscais obrigatórios no produto. ERP e PDV compilam; instalador 0.1.2. Pendente: conferir md5, aplicar 20261028, publicar as 2 Edge Functions, configurar a chave no UCP (homologação) e testar.
- **2026-10-27 (3)** — Cupom em negrito/preto puro (impressão térmica saía fraca pelo driver do Windows) e instalador **0.1.1**. Usuário instalou no PC da loja e **aprovou todos os testes** (2.8a, tela que cabe na janela, Nova reserva, cupom). Próximo: PR de `feat/2.8-finalizacao` para a `main` e escolher 2.8b (NFC-e Focus) ou 2.8c (ESC/POS).
- **2026-10-27 (2)** — Pedidos do usuário nos testes da 2.8a (confirmar se a 20261027 foi aplicada): (1) tela de venda cabe na janela (catálogo e carrinho rolam por dentro, rodapé do carrinho fixo; no celular volta a rolar a página); (2) vendedor e total lado a lado no rodapé; (3) **reserva saiu da tela de venda** e virou tela própria **"+ Nova reserva"** na tela de Reservas (busca, serial, encomenda, cliente, data, sinal com 1 forma, vendedor, voucher; venda em andamento fica guardada e volta depois; na venda, produto sem estoque orienta usar Nova reserva). Sem mudança no banco. (4) **Instalador** do PDV: `npx tauri build --bundles nsis` (em `KanguruPDV/`) → `src-tauri/target/release/bundle/nsis/Kanguru PDV_0.1.0_x64-setup.exe` (sem assinatura digital: Windows mostra aviso SmartScreen; assinatura na 2.11). Pendente: usuário testar.
- **2026-10-27** — PR #2 mergeado na `main`; branch `feat/2.8-finalizacao`. Focus NFe aprovada. 2.8a implementada (ver seção 5): migration 20261027 + ERP (fiscal no produto, editar produto, Instagram da loja, cupom no histórico) + PDV (NFC-e/Não Fiscal, cupom 80 mm, reimprimir). Builds ok; prévia do cupom conferida. Pendente: aplicar 20261027 e testar.
- **2026-10-26 (2)** — Usuário conferiu md5, aplicou a 20261026 e aprovou os testes do limite por produto. Branch `feat/2.7b-codigo-barras` acumula: código de barras, campos de valor, encomenda/voucher, clientes/garantia, loja em modal, limite por produto — tudo aplicado e testado. Próximo passo sugerido: PR para a `main` (com aprovação) e depois iniciar a 2.8.
- **2026-10-26** — Limite de desconto por produto (desenho aprovado: produto, com padrão da loja como reserva; serviços usam o da loja) implementado: migration 20261026 + ERP (campo no cadastro e "Desc. máx. %" editável na lista) + PDV (limite por item). Builds ok. Pendente: conferir md5, aplicar, testar.
- **2026-10-25 (3)** — Usuário aplicou a 20261025 e aprovou **todos os testes** (busca/encomenda, voucher, entrega, clientes PDV/ERP, garantia, não-regressão). Pergunta do usuário: por que o limite de desconto continua na loja — esclarecido que limite por produto estava só ADIADO (seção 8 item 2); proposta enviada (limite no produto com padrão da loja, ou só por produto), aguardando decisão.
- **2026-10-25 (2)** — ERP Configurações: cadastro/edição de loja saiu da lateral e virou janela (modal) aberta pelo botão **"Criar loja"** no card do perfil e pelo lápis da lista; regras do voucher continuam **por loja** (campo da loja, rótulo deixa isso claro). Sem mudança no banco.
- **2026-10-25** — Usuário conferiu md5 e aplicou 20261023 e 20261024. Ajustes dos testes: código exato de produto zerado mostra o card com "Sem estoque" (não adiciona direto); reserva de encomenda sem mercadoria mostra aviso no card e trava "Converter em venda" (migration `20261025_reservation_stock_ready.sql`, só `list_pos_reservations` + `stockReady`, NÃO aplicada; md5 vivo esperado 442e7e4250adbe11be3ba4255317d4e8 ou 7976a2a2ab5e6265d837b38f0b3ee51c).
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
