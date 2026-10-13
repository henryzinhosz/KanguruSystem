# Preparacao do Supabase para o PDV

O script foi alinhado ao schema atual do ERP. Revise-o em conjunto com o responsavel pelo banco antes de aplica-lo em producao.

## Pre-requisitos que a migration espera

- `public.app_users.auth_uid`: UUID que corresponde a `auth.users.id`.
- `public.app_users.tenant_id`: UUID do tenant do usuario.
- `public.app_users.role`: texto com os valores `SELLER` e `OPERATOR`.
- `public.app_users.display_name`: nome exibivel do operador.
- `public.app_users.unit_id`: texto; `unit_id` tambem e `TEXT` em `store_configs` e nas tabelas do PDV.

Nao ha flag de usuario ativo em `app_users` no schema fornecido. A ativacao do acesso ao PDV e controlada por `pos_operator_units.is_active` e `pos_terminals.is_active`.

## Ordem de execucao

1. Executar o script no SQL Editor ou como migration do projeto ERP.
2. Criar, no Supabase Auth, um usuario tecnico para cada terminal ou loja.
3. Inserir o terminal em `public.pos_terminals`, usando o UUID do usuario tecnico e o `tenant_id`/`unit_id` textual corretos.
4. Vincular cada vendedor ou operador da unidade em `public.pos_operator_units`, usando `operator_auth_uid`.
5. Registrar o PIN exclusivamente pela funcao `public.set_pos_operator_pin`; nunca inserir hashes manualmente no cliente.
6. Testar a funcao `public.validate_pos_operator_pin` autenticado como o usuario tecnico do terminal.

O script nao muda as RPCs legadas `process_sale_transaction` e `process_sale_cancellation`, preservando seus clientes atuais no ERP. O PDV deve chamar exclusivamente `process_pos_sale_transaction` e `process_pos_sale_cancellation`; ambas validam o terminal e `operator_authorization_id` no banco e registram o `auth_uid` e o nome do operador validado em vendas e movimentos.

O usuario tecnico do terminal deve existir somente em `auth.users` e `pos_terminals`: nao crie uma linha correspondente em `app_users`. As RPCs legadas identificam a loja por `app_users`; manter a conta tecnica fora dessa tabela impede que ela use o caminho legado do ERP em vez das RPCs protegidas do PDV.

## Cadastros iniciais

Depois de criar a conta tecnica no Supabase Auth, execute os comandos abaixo como administrador do banco. Substitua todos os valores entre `<...>` e nunca use um e-mail pessoal de vendedor como `auth_user_id`.

```sql
insert into public.pos_terminals (auth_user_id, tenant_id, unit_id, display_name)
values (
	'<UUID_DO_USUARIO_TECNICO_DO_AUTH>',
	'<UUID_DO_TENANT>',
	'<UNIT_ID_TEXTO>',
	'Caixa 01'
);

insert into public.pos_operator_units (operator_auth_uid, tenant_id, unit_id)
values (
	'<AUTH_UID_DO_SELLER_OU_OPERATOR>',
	'<UUID_DO_TENANT>',
	'<UNIT_ID_TEXTO>'
);
```

Com uma sessao autenticada de `ADMIN` ou `MANAGER` do mesmo tenant, cadastre ou troque o PIN por RPC:

```sql
select public.set_pos_operator_pin(
	'<AUTH_UID_DO_SELLER_OU_OPERATOR>',
	'<PIN_DE_4_A_8_DIGITOS>'
);
```

`validate_pos_operator_pin` retorna zero linhas para PIN invalido e uma linha com `authorization_id`, operador e expiracao para PIN valido. Esse comportamento permite gravar a tentativa invalida sem armazenar o PIN e sem sofrer rollback pela excecao da propria RPC.

## Busca de itens do PDV

Como a conta tecnica nao existe em `app_users`, ela nao deve consultar `products`, `services` e `inventory` diretamente. A interface usa a RPC `search_pos_items`, que valida o terminal e devolve produtos com estoque positivo e servicos ativos do tenant.

Antes de atualizar o PDV para a sub-fase 2.5, aplique uma vez a migration [20260929_services_item_discounts.sql](../../KanguruERP/supabase/migrations/20260929_services_item_discounts.sql) no SQL Editor do Supabase, depois das migrations de tenant, terminal, caixa e estoque serializado. Ela cria o catalogo `services`, o limite `store_configs.max_item_discount_percent`, a busca combinada e atualiza a RPC de venda/estorno. Configure o percentual por loja em Configuracoes no ERP; `0` bloqueia qualquer desconto.

## Reservas de produtos (sub-fase 2.6)

Aplique uma vez [20261003_pos_product_reservations.sql](../../KanguruERP/supabase/migrations/20261003_pos_product_reservations.sql) depois das migrations de tenant, terminal, caixa, estoque serializado e [20260929_services_item_discounts.sql](../../KanguruERP/supabase/migrations/20260929_services_item_discounts.sql). A migration cria reservas/log de sinais, altera busca e venda para respeitar quantidades reservadas, adiciona RPCs para criar/listar/cancelar e inclui sinais/devolucoes no fechamento do caixa. O cancelamento registra a devolucao manual; o estorno no adquirente continua sendo externo.

### Roteiro de teste de reservas

1. Inicie o PDV e abra o caixa. Adicione produto comum e serializado; abra o modal Reservar, informe cliente, prazo futuro e, em um dos casos, um sinal com forma de pagamento.
2. Confirme a reserva. O carrinho deve limpar; os produtos reservados deixam de aparecer na busca. Para o serializado, confirme que a unidade selecionada deixou de aparecer entre os seriais disponiveis e ficou com `status = 'RESERVADO'`.
3. Tente uma venda comum/segunda reserva da quantidade ja comprometida. O banco deve rejeitar excesso mesmo se a interface estiver desatualizada.
4. Na tela Reservas, converta uma reserva em venda e pague o saldo. Confira `sales.reservation_deposit_applied`, que a unidade serializada fica `VENDIDO`, e que o fechamento conta sinal e saldo uma unica vez.
5. Cancele outra reserva com sinal e confirme a forma da devolucao manual. A unidade serializada deve voltar a `DISPONIVEL`; produto comum volta a aparecer na busca; o fechamento deve deduzir a devolucao do metodo selecionado.
6. Crie uma reserva com prazo passado por SQL de teste ou aguarde o prazo. Ela deve aparecer destacada como vencida, continuar bloqueando a busca e permitir conversao ou cancelamento manual.

Confira reservas e estados serializados no SQL Editor:

```sql
select id, tenant_id, unit_id, customer_name, expires_at, deposit_amount,
	   deposit_payment_method, status, sale_id
from public.product_reservations
order by created_at desc
limit 20;

select reservation_id, product_id, quantity, serial_unit_id, serial_number,
	   item_sku, item_name, unit_price, discount_percent, line_total
from public.product_reservation_items
order by created_at desc
limit 30;

select id, product_id, unit_id, serial_number, status, sale_id
from public.product_serial_units
where status in ('RESERVADO', 'VENDIDO')
order by updated_at desc
limit 30;
```

## Correcao de nome de operador

Se a validacao do PIN retornar `column user_record.display_name does not exist`, o projeto ERP esta sem a coluna que as RPCs do PDV usam para registrar `sales.operator_name` e `movements.operator_name`. Execute uma unica vez [20260723_pos-operator-display-name.sql](../supabase/20260723_pos-operator-display-name.sql) no SQL Editor. O script cria a coluna e tenta preencher os nomes por metadados do Auth ou pelo trecho anterior a `@` do e-mail; ele interrompe a execucao se algum nome ainda ficar vazio.

Se a validacao retornar `column reference "expires_at" is ambiguous`, execute uma unica vez [20260723_fix-pin-authorization-expiration.sql](../supabase/20260723_fix-pin-authorization-expiration.sql). Esse patch substitui somente `validate_pos_operator_pin`, nao altera nenhum cadastro existente e nao usa `RETURNING`.

## Roteiro de teste da venda

1. Aplique a migration 2.5 acima e cadastre no ERP um servico ativo, por exemplo `INST-01 / Instalacao / R$ 80,00`.
2. Configure o limite de desconto da loja no ERP, por exemplo `10%`, e inicie o PDV com `npm run tauri dev` depois de instalar Rust/Cargo.
3. Entre com a conta tecnica do terminal e abra o caixa.
4. Busque e adicione o servico. Confirme que aparece como `Servico`, sem saldo de estoque; finalize a venda e confira que nenhum movimento de estoque foi criado para ele.
5. Adicione um produto comum e outro serializado; ambos devem continuar respeitando saldo e selecao de serial.
6. Aplique `10%` de desconto em uma linha e finalize: o total deve refletir o desconto e o JSON da venda deve guardar `unitPrice`, `discountPercent` e `lineTotal` por item.
7. Tente informar mais de `10%`: o PDV deve bloquear a alteracao com mensagem clara. Tambem valide a protecao do banco alterando manualmente o payload para exceder o limite; a RPC deve rejeitar e nao registrar venda nem movimento.
8. Cancele pelo ERP uma venda que contenha servico e produto: o estoque deve ser devolvido somente para o produto.
9. No SQL Editor, confirme a venda e o operador:

```sql
select id, unit_id, operator_id, operator_name, gross_amount, fee_amount, net_amount, payment_method, status, timestamp
from public.sales
where unit_id = 'loja_beb_games_campo_grande'
order by timestamp desc
limit 10;

select product_id, from_unit_id, to_unit_id, type, quantity, operator_id, operator_name, reason, timestamp
from public.movements
where from_unit_id = 'loja_beb_games_campo_grande'
	and reason = 'Venda registrada'
order by timestamp desc
limit 20;
```

O `operator_id` deve ser o UUID do usuario `SELLER` e nunca o UUID da conta tecnica. Confirme tambem o novo saldo no JSON de `inventory.quantities` para a mesma unidade.