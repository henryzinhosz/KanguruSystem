# Roteiro guardado: teste do bloqueio de assinatura e terminal da loja

Guardado em 2026-11-08 a pedido do usuário, para retomar depois.

## Situação quando foi guardado

- Tela de bloqueio funcionou no ERP (janela anônima) e no PDV do notebook, com o botão Fechar caixa.
- ERP na janela normal: fechar **todas** as abas e janelas do ERP e abrir de novo, ou clicar em **Atualizar**, para sair da versão antiga guardada. Falta confirmar que a tela de bloqueio aparece ali também.
- Banco conferido: os 2 terminais ("Caixa 01" e "Beb Games CG") continuam ativos e as identidades existem. Quem perdeu a identidade foi o computador da loja.
- A CBEX ficou com cobrança configurada desde outubro/2026, vencimento dia 5 (teste).

## Passos para terminar

1. Na aba **Cobrança** (UCP › ficha do cliente), registrar as mensalidades em aberto (outubro e novembro) e ver o ERP e o PDV do notebook liberarem.
2. Voltar a CBEX para isenta: marcar **Isento** e clicar em **Salvar cobrança**.
3. Reativar o PC da loja: UCP › ficha › **Terminais PDV**, gerar código para a loja Park Shopping e digitar no PDV da loja. Entra como terminal novo e usa a senha Gerente da loja.
4. Informar o nome do terminal novo e qual dos antigos era o da loja, para desativar o antigo por comando (o UCP não tem botão para isso).

## Melhoria proposta (aguarda aprovação)

Causa da perda da chave ainda não comprovada. Hipótese: o servidor recusa uma chave antiga reapresentada depois da troca, por exemplo se o programa fechar logo depois de trocar a chave (numa atualização).

- O PDV para de apagar a chave quando há recusa e registra o motivo exato.
- A chave passa a ser salva antes de qualquer fechamento ou atualização do programa.
- Botão **"Reativar este terminal"** no UCP: gera um código que devolve o aparelho ao mesmo terminal, em vez de criar outro.
