-- Total de tributos (IBPT) = 26% em todos os produtos (informado pelo contador em 2026-11-06).
-- So muda a coluna tax_burden_percent; nada mais do produto e alterado.

BEGIN;

UPDATE public.products
SET tax_burden_percent = 26
WHERE tax_burden_percent IS DISTINCT FROM 26;

COMMIT;

-- Conferencia: deve mostrar so a linha 26 com a quantidade de produtos.
SELECT tax_burden_percent, COUNT(*) AS produtos
FROM public.products
GROUP BY tax_burden_percent;
