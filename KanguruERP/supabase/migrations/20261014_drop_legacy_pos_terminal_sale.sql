-- =========================================================================
-- Remove a versao antiga (12 parametros, retorno void, logica da 2.5) de
-- process_pos_terminal_sale que sobrou no banco ativo.
--
-- A migration 20261003 (2.6) ja fazia este DROP, mas a versao foi recriada
-- depois (reaplicacao da 20260929). Ela nao tem aprovacao de desconto por
-- senha, auditoria nem pagamento dividido, e continuava com GRANT para
-- authenticated. O PDV usa somente a versao de 15 parametros (20261008).
--
-- Remove apenas a assinatura exata de 12 parametros; a versao vigente nao
-- e afetada.
-- =========================================================================

DROP FUNCTION IF EXISTS public.process_pos_terminal_sale(
  TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN
);
