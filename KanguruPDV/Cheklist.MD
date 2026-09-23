# Pontos Importantes que faltam no sistema

Passo 3 (gerar código de ativação) ainda é manual, via SQL — não existe uma tela no UCP ou no ERP do cliente pra isso ainda. Seria um bom candidato pra quando vocês voltarem a mexer no UCP.

Produtos serializados, serviços, reserva, pagamento dividido, aprovação de desconto, NFC-e, trocas — ainda não implementados no PDV (é o que vem nas próximas sub-fases).

Bloqueio por inadimplência — o campo de status de assinatura existe no UCP, mas nada ainda impede o uso do ERP/PDV se o cliente for marcado como bloqueado (vocês decidiram deixar isso pra depois do PDV pronto).