-- =========================================================================
-- Taxas do cartao ate 21x (pedido urgente do usuario em 2026-11-21).
-- So troca public.pos_card_fee_rate (mesma assinatura e retorno): o credito passa a ler a
-- taxa de 1x a 21x da tabela da loja (store_configs.card_fee_table.credito com ate 21 valores).
-- Nenhuma outra funcao limitava a 12 parcelas (sale_payments.installments so exige >= 1).
-- Antes de aplicar, md5(prosrc) de pos_card_fee_rate deve ser
-- c0b2cb4e181b3cdf4822a1c1d225d93f (LF) ou fee12510ba725817531b7ce2a1150a04 (CRLF).
-- =========================================================================

CREATE OR REPLACE FUNCTION public.pos_card_fee_rate(p_table JSONB, p_method TEXT, p_installments INTEGER)
  RETURNS NUMERIC
  LANGUAGE sql
  IMMUTABLE
  SET search_path = public
  AS $$
    SELECT COALESCE(CASE
      WHEN p_table IS NULL THEN 0
      WHEN UPPER(p_method) = 'DEBITO' THEN NULLIF(p_table->>'debito', '')::NUMERIC
      WHEN UPPER(p_method) = 'CREDITO' AND p_installments BETWEEN 1 AND 21
        THEN NULLIF(p_table->'credito'->>(p_installments - 1), '')::NUMERIC
    END, 0);
  $$;

REVOKE ALL ON FUNCTION public.pos_card_fee_rate(JSONB, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
