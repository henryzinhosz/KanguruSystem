# Roteiro de aplicação e testes — Contingência da NFC-e + Modo offline do PDV

> Guardado a pedido do usuário em 2026-10-28. Reenviar quando ele pedir "os testes offline".
> Commits: `d3585c3` (contingência, caso 1) e `9356b5d` (modo offline).

O modo offline (junto com o caso 1 da contingência) está pronto e salvo. PDV e ERP compilam.
**Ainda não foi testado de verdade**: as migrations não foram aplicadas e nada foi publicado.
Os testes reais são no PC da loja, com a internet desligada.

## Como fica no PDV

- Sem internet, aparece uma faixa vermelha **"MODO OFFLINE"** e o PDV continua vendendo, com
  produtos, preços, estoque, seriais e vendedores da cópia guardada no computador.
- **Funciona sem internet:** venda (Não Fiscal e NFC-e pelo Comunicador), sangria, suprimento e
  reimpressão da última venda offline. O cliente é digitado com CPF e nome.
- **Fica bloqueado sem internet:** reservas, garantia, trocas, vale-troca, desconto acima do limite
  e fechamento do caixa.
- **Quando a internet volta**, o PDV envia tudo sozinho. Se algo não bater (serial já vendido,
  estoque que ficou negativo, preço que mudou), a venda entra assim mesmo e aparece no ERP ›
  Histórico, num painel **"Vendas sem internet com divergência"** com o botão "Resolvida".
- **Dá para abrir o PDV sem internet:** ele pede a senha administrativa e confere com a do último
  desbloqueio feito com internet.

**Risco antigo corrigido:** abrir o PDV sem internet podia apagar a ativação do terminal. Agora
não apaga mais.

## Passo a passo

1. **Conferência no SQL Editor:**
   ```sql
   select proname item, md5(prosrc) valor from pg_proc where proname in ('get_pos_sale_receipt','search_pos_sales','get_pos_offline_snapshot','import_pos_offline_sale')
   union all select 'tabela', table_name from information_schema.tables where table_schema='public' and table_name='pos_offline_conflicts'
   union all select 'coluna', column_name from information_schema.columns where table_schema='public' and table_name='sales' and column_name in ('nfce_contingency','offline_origin');
   ```
   O esperado são só duas linhas: `get_pos_sale_receipt` = `e2c16ec23286125c00c4658ac01525cf`
   (CRLF; LF: `fe90c18b5920e935b46a44adb56f08e4`) e `search_pos_sales` =
   `91ccf7038fcaa9ab5781e3f9469d36c8` (CRLF; LF: `1df6344856403951953ebcbe89679dcb`).
2. Aplicar **na ordem**: `KanguruERP/supabase/migrations/20261031_nfce_contingency.sql` e depois
   `KanguruERP/supabase/migrations/20261101_pos_offline.sql`.
3. **Edge Functions:** atualizar a `nfce-emit` e criar a `nfce-contingency-sync`
   (`supabase/functions/nfce-contingency-sync/index.ts`; a URL deve terminar em `/nfce-contingency-sync`).
4. Claude publica o **PDV 0.1.9** (`node scripts/release-pdv.mjs "notas"`) e o PC da loja atualiza pelo aviso.
5. **No PC da loja:**
   - desbloquear o PDV **uma vez com internet**, para ele guardar a senha;
   - **instalar o Comunicador Offline** pelo painel da Focus, ativar e importar o certificado;
   - no PDV, em **Cupons e notas › Comunicador Offline**, informar a porta que o Comunicador mostrar.

## Testes

- (a) Desligar a internet: a faixa vermelha deve aparecer em até 20 segundos.
- (b) Fazer uma venda **Não Fiscal**, uma com **serial** e uma **sangria**.
- (c) Fazer uma venda **NFC-e**: o cupom deve sair em contingência e em duas vias.
- (d) Fechar e abrir o PDV, ainda sem internet, e desbloquear.
- (e) Religar a internet: as vendas devem aparecer no ERP e as notas devem ser efetivadas,
  perdendo o "em contingência" em até 10 minutos.

A parte do Comunicador foi feita com base na documentação e na resposta do suporte da Focus, sem
teste real. Se ele recusar a nota, pedir a mensagem que aparecer.
