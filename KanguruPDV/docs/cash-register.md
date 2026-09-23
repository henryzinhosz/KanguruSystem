# Caixa do terminal

## Implantacao

1. Execute [20260724_cash-register.sql](../supabase/20260724_cash-register.sql) no SQL Editor do mesmo projeto Supabase usado pelo PDV, depois de [20260723_terminal-activation.sql](../supabase/20260723_terminal-activation.sql).
2. Recompile ou reinicie o aplicativo. O terminal precisa estar ativado e desbloqueado para abrir caixa.
3. Cada terminal possui no maximo uma sessao com status `ABERTO`. Vendas pelo RPC do PDV sao recusadas pelo banco enquanto nao houver uma sessao aberta.

## Roteiro de conferencia

1. Desbloqueie o terminal e abra `Caixa 01` em nome de `Maria`, com `100,00` de troco inicial.
2. Registre uma venda em dinheiro de `50,00`.
3. No cabecalho, registre uma **Sangria** de `20,00`, com um motivo.
4. Escolha fechar caixa. O esperado em dinheiro deve ser `130,00` ($100 + 50 - 20$).
5. Informe `125,00` no contado em dinheiro e confirme com a senha administrativa.
6. A sessao deve ser fechada com diferenca de dinheiro `-5,00`; o aplicativo volta para **Abrir caixa** e deixa de permitir vendas ate uma nova abertura.

## Conferencia no SQL Editor

```sql
select
  id,
  cash_number,
  status,
  opened_by_name,
  opening_float_amount,
  expected_cash_amount,
  counted_cash_amount,
  cash_difference_amount,
  opened_at,
  closed_at
from public.cash_register_sessions
order by opened_at desc;

select
  movement.type,
  movement.amount,
  movement.reason,
  movement.operator_name,
  movement.created_at
from public.cash_register_movements movement
order by movement.created_at desc;

select
  sale.id,
  sale.invoice_number,
  sale.payment_method,
  sale.gross_amount,
  sale.cash_session_id,
  sale.timestamp
from public.sales sale
where sale.cash_session_id is not null
order by sale.timestamp desc;
```

Os valores esperados sao sempre recalculados no banco no instante do fechamento. O aplicativo apenas exibe a conferencia e envia as contagens informadas.