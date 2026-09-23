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

## Busca de produtos do PDV

Como a conta tecnica nao existe em `app_users`, ela nao deve consultar `products` e `inventory` diretamente. A interface usa a RPC `search_pos_products`, que valida o terminal e devolve somente produtos do tenant e da unidade vinculados a ele, com estoque positivo.

Se voce ja aplicou uma versao anterior de `pos-terminal-and-pin.sql`, execute tambem [20260723_pos-product-search.sql](../supabase/20260723_pos-product-search.sql) uma unica vez no SQL Editor. Nao execute o arquivo inteiro original novamente, pois ele cria uma policy que ja existe.

## Correcao de nome de operador

Se a validacao do PIN retornar `column user_record.display_name does not exist`, o projeto ERP esta sem a coluna que as RPCs do PDV usam para registrar `sales.operator_name` e `movements.operator_name`. Execute uma unica vez [20260723_pos-operator-display-name.sql](../supabase/20260723_pos-operator-display-name.sql) no SQL Editor. O script cria a coluna e tenta preencher os nomes por metadados do Auth ou pelo trecho anterior a `@` do e-mail; ele interrompe a execucao se algum nome ainda ficar vazio.

Se a validacao retornar `column reference "expires_at" is ambiguous`, execute uma unica vez [20260723_fix-pin-authorization-expiration.sql](../supabase/20260723_fix-pin-authorization-expiration.sql). Esse patch substitui somente `validate_pos_operator_pin`, nao altera nenhum cadastro existente e nao usa `RETURNING`.

## Roteiro de teste da venda

1. Execute a migration de busca acima, se necessario, e inicie o PDV com `npm run tauri dev` depois de instalar Rust/Cargo.
2. Entre com o e-mail e senha da conta tecnica vinculada a `loja_beb_games_campo_grande`.
3. Informe o PIN do operador de teste. A tela deve mostrar o nome do operador no cabecalho.
4. Busque um produto que tenha saldo positivo nessa loja, clique no resultado, escolha o pagamento e finalize a venda.
5. No SQL Editor, confirme a venda e o operador:

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