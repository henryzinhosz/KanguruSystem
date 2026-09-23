# Ativacao de terminal PDV

## Preparacao unica

1. No Supabase, abra **Authentication > Providers > Anonymous Sign-Ins** e habilite o provedor anonimo.
2. Execute [20260723_terminal-activation.sql](../supabase/20260723_terminal-activation.sql) no SQL Editor do projeto ERP.
3. O script preserva as tabelas historicas de PIN, mas revoga a execucao das RPCs antigas. Nao reaplique as migrations antigas de PIN depois dele.
4. O aplicativo desktop usa o backend `windows-native` do crate Rust `keyring`. A primeira ativacao feita antes dessa configuracao nao persiste fora do processo e deve ser refeita uma vez apos recompilar o aplicativo.

## Gerar um codigo de teste

Escolha um codigo de 12 caracteres alfanumericos. O exemplo abaixo usa `A7K9M2Q4R6TZ`; substitua pelo tenant e pela loja reais e guarde o codigo em local seguro ate a ativacao.

```sql
insert into public.pos_terminal_activations (
  code_hash,
  tenant_id,
  unit_id,
  terminal_label,
  expires_at
)
values (
  crypt('A7K9M2Q4R6TZ', gen_salt('bf', 12)),
  '<UUID_DO_TENANT>',
  'loja_beb_games_campo_grande',
  'Caixa 01',
  now() + interval '24 hours'
);
```

O banco guarda somente o hash. O codigo e de uso unico, expira em 24 horas e a sessao do dispositivo e limitada a cinco tentativas invalidas em 15 minutos.

## Testar ativacao e desbloqueio

1. Execute `npm run tauri dev` depois de instalar Rust/Cargo. Para conferir somente a interface web, use `npm run dev`.
2. Em um terminal nunca ativado, informe `Caixa 01` e o codigo de ativacao. A tela seguinte deve mostrar nome fantasia, razao social, CNPJ e endereco de `store_configs`.
3. Defina uma senha administrativa de pelo menos oito caracteres e confirme-a.
4. Desbloqueie o terminal usando essa senha. Se nao houver um caixa aberto, a tela **Abrir caixa** deve aparecer antes da tela de venda.
5. Feche completamente o aplicativo e abra-o de novo. O dispositivo deve pular a ativacao e mostrar somente a tela **Desbloquear terminal**.
6. Siga o roteiro em [cash-register.md](cash-register.md) para abrir, movimentar e fechar o caixa. A venda e o movimento usarao o ID e o nome do terminal em `operator_id` e `operator_name` ate existir uma identificacao individual futura.

## Conferencias no SQL Editor

```sql
select
  terminal.id,
  terminal.display_name,
  terminal.device_auth_uid,
  terminal.tenant_id,
  terminal.unit_id,
  terminal.activated_at,
  terminal.last_unlocked_at,
  terminal.is_active
from public.pos_terminals terminal
where terminal.unit_id = 'loja_beb_games_campo_grande';

select
  activation.terminal_label,
  activation.expires_at,
  activation.used_at,
  activation.used_by_auth_uid
from public.pos_terminal_activations activation
where activation.unit_id = 'loja_beb_games_campo_grande'
order by activation.created_at desc;

select tenant_id, unit_id, trade_name, legal_name, cnpj, address
from public.store_configs
where unit_id = 'loja_beb_games_campo_grande';
```

## Permissoes futuras

A senha administrativa compartilhada desbloqueia o terminal e confirma o fechamento de caixa, mas nao identifica um `MANAGER`. Antes de implementar cancelamento ou desconto, a aplicacao deve solicitar uma autorizacao individual curta de um usuario `MANAGER` e validar esse papel no banco. A venda normal continuara sendo permissao do terminal desbloqueado.