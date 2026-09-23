-- Cria o vínculo de uma conta Auth existente como ADMIN do tenant padrão.
-- 1. Crie a conta no Supabase Dashboard > Authentication > Users (ou por um fluxo de cadastro).
-- 2. Copie o UUID exibido para a conta e substitua o valor abaixo.
-- 3. Execute este script no SQL Editor.

BEGIN;

INSERT INTO public.app_users (auth_uid, role, tenant_id, unit_id)
VALUES (
  'COLE-O-UUID-DA-CONTA-AUTH-AQUI',
  'ADMIN',
  '00000000-0000-4000-8000-000000000001',
  'central'
)
ON CONFLICT (auth_uid) DO UPDATE
SET
  role = EXCLUDED.role,
  tenant_id = EXCLUDED.tenant_id,
  unit_id = EXCLUDED.unit_id;

COMMIT;
