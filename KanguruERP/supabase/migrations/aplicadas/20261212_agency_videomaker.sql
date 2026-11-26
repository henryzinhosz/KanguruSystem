-- Agencia de IA, etapa C: VideoMaker (desenho aprovado em 2026-11-25; fica dentro da sala de
-- Marketing, opcao A, com importacao de pasta publica do Google Drive).
--
-- O franqueado sobe videos (do computador ou de uma pasta do Drive). O navegador tira ~8 fotos
-- de cada video e transcreve o audio; a IA escreve a legenda; o franqueado revisa e APROVA; o
-- servidor (Edge Function agency-videomaker, chamada a cada 5 minutos pelo pg_cron) publica no
-- Instagram da loja na hora marcada. Nada e postado sem aprovacao.
--
-- Instagram: "API do Instagram com login do Instagram". A chave de acesso fica SO nesta tabela
-- fechada (sem politicas; so o servidor le) e e renovada sozinha antes de vencer (60 dias).
--
-- Aditiva: tabelas, bucket e funcoes novas. Muda so (CREATE OR REPLACE, mesma assinatura, ambas da
-- 20261211) agency_used_this_month e platform_get_agency, para contar as legendas no limite e no
-- custo do mes.
--
-- Pre-requisito (conferido em 2026-11-25): extensoes pg_cron e pg_net disponiveis.
-- md5 vivos esperados (versao da 20261211):
--   agency_used_this_month 1cb8d9e5e12f28e64476e115da4fa6b5 (LF) / a7f272833f4478a4192ffa6f2b2d7d37 (CRLF)
--   platform_get_agency    80c4555a64e7f962a060cb7656085a0f (LF) / ed18569593e9d257f5aa2b2c89392f47 (CRLF)

-- ---------------- Extensoes (agendador e chamadas HTTP do banco) ----------------
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ---------------- Instagram conectado (uma conta por loja) ----------------
CREATE TABLE IF NOT EXISTS public.agency_instagram_accounts (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  ig_user_id TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  access_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  token_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'ATIVA' CHECK (status IN ('ATIVA', 'EXPIRADA')),
  last_error TEXT,
  connected_by UUID,
  connected_by_name TEXT NOT NULL DEFAULT '',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, unit_id)
);

-- Pedido de conexao em andamento (protege o retorno do Instagram; vale 15 minutos).
CREATE TABLE IF NOT EXISTS public.agency_instagram_oauth_states (
  state TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  user_id UUID NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  return_to TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Segredo que o agendador manda para a Edge Function (gerado aqui; ninguem precisa digitar).
CREATE TABLE IF NOT EXISTS public.agency_videomaker_cron (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret TEXT NOT NULL
);
INSERT INTO public.agency_videomaker_cron (id, secret)
VALUES (1, replace(gen_random_uuid()::TEXT, '-', '') || replace(gen_random_uuid()::TEXT, '-', ''))
ON CONFLICT (id) DO NOTHING;

-- Tudo isso so o servidor (service role) le e grava.
ALTER TABLE public.agency_instagram_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_instagram_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_videomaker_cron ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agency_instagram_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.agency_instagram_oauth_states FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.agency_videomaker_cron FROM PUBLIC, anon, authenticated;

-- ---------------- Configuracao do VideoMaker por loja ----------------
CREATE TABLE IF NOT EXISTS public.agency_videomaker_settings (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  slot_times TEXT[] NOT NULL DEFAULT ARRAY['12:00', '18:00'],
  niche TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, unit_id)
);

-- ---------------- Videos (fila e calendario) ----------------
-- status: RASCUNHO (falta aprovar) | APROVADO (agendado) | PUBLICANDO | PUBLICADO | ERRO |
--         PAUSADO | CANCELADO
CREATE TABLE IF NOT EXISTS public.agency_videos (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  file_name TEXT NOT NULL DEFAULT '',
  storage_path TEXT NOT NULL,
  frame_paths TEXT[] NOT NULL DEFAULT '{}',
  mime_type TEXT NOT NULL DEFAULT 'video/mp4',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  duration_seconds NUMERIC(8, 2) NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  source TEXT NOT NULL DEFAULT 'ARQUIVO' CHECK (source IN ('ARQUIVO', 'DRIVE')),
  drive_file_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  caption_source TEXT NOT NULL DEFAULT '' CHECK (caption_source IN ('', 'IA', 'TESTE', 'MANUAL')),
  caption_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RASCUNHO'
    CHECK (status IN ('RASCUNHO', 'APROVADO', 'PUBLICANDO', 'PUBLICADO', 'ERRO', 'PAUSADO', 'CANCELADO')),
  approved_at TIMESTAMPTZ,
  approved_by UUID,
  approved_by_name TEXT NOT NULL DEFAULT '',
  ig_container_id TEXT,
  ig_media_id TEXT,
  ig_permalink TEXT,
  publish_started_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  video_deleted_at TIMESTAMPTZ,
  rights_confirmed_by UUID NOT NULL,
  rights_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agency_videos_store_idx ON public.agency_videos (tenant_id, unit_id, position);
CREATE INDEX IF NOT EXISTS agency_videos_due_idx ON public.agency_videos (scheduled_at) WHERE status = 'APROVADO';
CREATE INDEX IF NOT EXISTS agency_videos_publishing_idx ON public.agency_videos (publish_started_at) WHERE status = 'PUBLICANDO';

-- Cada legenda feita pela IA (conta 1 pergunta no limite do mes e entra no custo).
CREATE TABLE IF NOT EXISTS public.agency_video_captions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  video_id UUID REFERENCES public.agency_videos(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agency_video_captions_usage_idx ON public.agency_video_captions (tenant_id, created_at);

-- Leitura e escrita so pelas funcoes abaixo (e pelo servidor).
ALTER TABLE public.agency_videomaker_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_video_captions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agency_videomaker_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.agency_videos FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.agency_video_captions FROM PUBLIC, anon, authenticated;

-- ---------------- Limite e custo do mes passam a contar as legendas ----------------
-- (copias da 20261211 + as legendas do VideoMaker)
CREATE OR REPLACE FUNCTION public.agency_used_this_month(p_tenant_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    SELECT COUNT(*)::INTEGER
    FROM public.agency_messages
    WHERE tenant_id = p_tenant_id
      AND role = 'assistant'
      AND created_at >= public.agency_month_start()
  ) + (
    SELECT COUNT(*)::INTEGER
    FROM public.agency_video_captions
    WHERE tenant_id = p_tenant_id
      AND created_at >= public.agency_month_start()
  );
$$;

CREATE OR REPLACE FUNCTION public.platform_get_agency(p_tenant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant public.tenants%ROWTYPE;
  v_start TIMESTAMPTZ := public.agency_month_start();
  v_prev TIMESTAMPTZ := (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '1 month')) AT TIME ZONE 'America/Sao_Paulo';
  v_month RECORD;
  v_last RECORD;
  v_captions RECORD;
  v_captions_last RECORD;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  SELECT * INTO v_tenant FROM public.tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente não encontrado'; END IF;

  SELECT COUNT(*)::INTEGER AS answers, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(DISTINCT user_id)::INTEGER AS people
  INTO v_month
  FROM public.agency_messages
  WHERE tenant_id = p_tenant_id AND role = 'assistant' AND created_at >= v_start;

  SELECT COUNT(*)::INTEGER AS answers, COALESCE(SUM(cost_usd), 0) AS cost
  INTO v_last
  FROM public.agency_messages
  WHERE tenant_id = p_tenant_id AND role = 'assistant' AND created_at >= v_prev AND created_at < v_start;

  SELECT COUNT(*)::INTEGER AS answers, COALESCE(SUM(cost_usd), 0) AS cost
  INTO v_captions
  FROM public.agency_video_captions
  WHERE tenant_id = p_tenant_id AND created_at >= v_start;

  SELECT COUNT(*)::INTEGER AS answers, COALESCE(SUM(cost_usd), 0) AS cost
  INTO v_captions_last
  FROM public.agency_video_captions
  WHERE tenant_id = p_tenant_id AND created_at >= v_prev AND created_at < v_start;

  RETURN jsonb_build_object(
    'enabled', v_tenant.agency_enabled,
    'limit', v_tenant.agency_monthly_limit,
    'used', v_month.answers + v_captions.answers,
    'costUsd', v_month.cost + v_captions.cost,
    'people', v_month.people,
    'lastMonthUsed', v_last.answers + v_captions_last.answers,
    'lastMonthCostUsd', v_last.cost + v_captions_last.cost,
    'captions', v_captions.answers
  );
END;
$$;

-- ---------------- Funcoes internas ----------------
-- Quem pode usar o VideoMaker numa loja: dono ou gerente com a area "agencia" e acesso a loja.
-- Agencia desligada/assinatura bloqueada impedem; limite do mes so impede a legenda pela IA.
CREATE OR REPLACE FUNCTION public.videomaker_actor_of(p_user UUID, p_unit_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_access JSONB;
  v_user public.app_users%ROWTYPE;
  v_tenant UUID;
BEGIN
  IF p_user IS NULL THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  v_access := public.agency_access_of(p_user);
  IF NOT COALESCE((v_access ->> 'ok')::BOOLEAN, false) AND COALESCE(v_access ->> 'reason', '') <> 'LIMITE' THEN
    RAISE EXCEPTION 'Sem acesso à Agência (%)', COALESCE(v_access ->> 'reason', 'SEM_ACESSO');
  END IF;
  v_tenant := (v_access ->> 'tenantId')::UUID;
  SELECT * INTO v_user FROM public.app_users WHERE auth_uid = p_user;

  IF NOT EXISTS (SELECT 1 FROM public.store_configs WHERE tenant_id = v_tenant AND unit_id = p_unit_id) THEN
    RAISE EXCEPTION 'Loja não encontrada';
  END IF;
  IF v_user.role <> 'ADMIN'
     AND COALESCE(v_user.unit_id, '') <> p_unit_id
     AND NOT EXISTS (
       SELECT 1 FROM public.user_store_access
       WHERE auth_uid = p_user AND tenant_id = v_tenant AND unit_id = p_unit_id
     ) THEN
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;

  RETURN jsonb_build_object(
    'tenantId', v_tenant,
    'unitId', p_unit_id,
    'userId', p_user,
    'name', v_access ->> 'displayName',
    'role', v_user.role,
    'isOwner', v_user.role = 'ADMIN',
    'captionOk', COALESCE((v_access ->> 'ok')::BOOLEAN, false),
    'reason', v_access ->> 'reason',
    'used', v_access -> 'used',
    'limit', v_access -> 'limit'
  );
END;
$$;

-- Mesma conferencia para o login do ERP.
CREATE OR REPLACE FUNCTION public.videomaker_actor(p_unit_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  RETURN public.videomaker_actor_of(auth.uid(), p_unit_id);
END;
$$;

-- Trava um video da empresa do login e confere o acesso a loja dele.
CREATE OR REPLACE FUNCTION public.videomaker_lock_video(p_id UUID)
RETURNS public.agency_videos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_video public.agency_videos;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  SELECT * INTO v_video FROM public.agency_videos WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vídeo não encontrado'; END IF;
  PERFORM public.videomaker_actor(v_video.unit_id);
  IF v_video.tenant_id <> public.current_user_tenant_id() THEN RAISE EXCEPTION 'Vídeo não encontrado'; END IF;
  RETURN v_video;
END;
$$;

-- Legenda: ate 2.200 caracteres e 30 hashtags (regras do Instagram).
CREATE OR REPLACE FUNCTION public.videomaker_check_caption(p_caption TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF char_length(COALESCE(p_caption, '')) > 2200 THEN
    RAISE EXCEPTION 'A legenda pode ter até 2.200 caracteres';
  END IF;
  IF (SELECT COUNT(*) FROM regexp_matches(COALESCE(p_caption, ''), '#[^[:space:]#]+', 'g')) > 30 THEN
    RAISE EXCEPTION 'A legenda pode ter até 30 hashtags';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.videomaker_video_json(v public.agency_videos)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', v.id,
    'unitId', v.unit_id,
    'position', v.position,
    'fileName', v.file_name,
    'storagePath', v.storage_path,
    'framePaths', to_jsonb(v.frame_paths),
    'mimeType', v.mime_type,
    'sizeBytes', v.size_bytes,
    'durationSeconds', v.duration_seconds,
    'width', v.width,
    'height', v.height,
    'source', v.source,
    'note', v.note,
    'transcript', v.transcript,
    'caption', v.caption,
    'captionSource', v.caption_source,
    'captionAt', v.caption_at,
    'scheduledAt', v.scheduled_at,
    'status', v.status,
    'approvedAt', v.approved_at,
    'approvedByName', v.approved_by_name,
    'permalink', v.ig_permalink,
    'publishedAt', v.published_at,
    'errorMessage', v.error_message,
    'attempts', v.attempts,
    'videoDeleted', v.video_deleted_at IS NOT NULL,
    'createdByName', v.created_by_name,
    'createdAt', v.created_at
  );
$$;

REVOKE ALL ON FUNCTION public.videomaker_actor_of(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.videomaker_actor(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.videomaker_lock_video(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.videomaker_check_caption(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.videomaker_video_json(public.agency_videos) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.videomaker_actor_of(UUID, TEXT) TO service_role;

-- ---------------- ERP ----------------
-- Tudo o que a tela do VideoMaker precisa de uma loja.
CREATE OR REPLACE FUNCTION public.get_videomaker_state(p_unit_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor JSONB := public.videomaker_actor(p_unit_id);
  v_tenant UUID := (v_actor ->> 'tenantId')::UUID;
  v_account public.agency_instagram_accounts%ROWTYPE;
  v_settings public.agency_videomaker_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_account FROM public.agency_instagram_accounts WHERE tenant_id = v_tenant AND unit_id = p_unit_id;
  SELECT * INTO v_settings FROM public.agency_videomaker_settings WHERE tenant_id = v_tenant AND unit_id = p_unit_id;

  RETURN jsonb_build_object(
    'isOwner', (v_actor ->> 'isOwner')::BOOLEAN,
    'captionOk', (v_actor ->> 'captionOk')::BOOLEAN,
    'reason', v_actor ->> 'reason',
    'used', v_actor -> 'used',
    'limit', v_actor -> 'limit',
    'maxActive', 40,
    'account', CASE WHEN v_account.tenant_id IS NULL THEN NULL ELSE jsonb_build_object(
      'username', v_account.username,
      'status', CASE WHEN v_account.status = 'ATIVA' AND v_account.token_expires_at <= now() THEN 'EXPIRADA' ELSE v_account.status END,
      'expiresAt', v_account.token_expires_at,
      'lastError', v_account.last_error,
      'connectedByName', v_account.connected_by_name,
      'connectedAt', v_account.connected_at
    ) END,
    'settings', jsonb_build_object(
      'slotTimes', to_jsonb(COALESCE(v_settings.slot_times, ARRAY['12:00', '18:00'])),
      'niche', COALESCE(v_settings.niche, '')
    ),
    'videos', COALESCE((
      SELECT jsonb_agg(public.videomaker_video_json(v) ORDER BY
        CASE WHEN v.status IN ('PUBLICADO', 'CANCELADO') THEN 1 ELSE 0 END,
        CASE WHEN v.status IN ('PUBLICADO', 'CANCELADO') THEN NULL ELSE v.position END,
        COALESCE(v.published_at, v.updated_at) DESC)
      FROM public.agency_videos v
      WHERE v.tenant_id = v_tenant AND v.unit_id = p_unit_id
        AND (v.status NOT IN ('PUBLICADO', 'CANCELADO') OR v.updated_at >= now() - INTERVAL '60 days')
    ), '[]'::JSONB)
  );
END;
$$;

-- Horarios (1 a 4, "HH:MM") e o texto sobre a loja e o publico (vai para a IA).
CREATE OR REPLACE FUNCTION public.save_videomaker_settings(p_unit_id TEXT, p_slot_times TEXT[], p_niche TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor JSONB := public.videomaker_actor(p_unit_id);
  v_times TEXT[];
BEGIN
  SELECT array_agg(DISTINCT t ORDER BY t) INTO v_times
  FROM unnest(COALESCE(p_slot_times, '{}')) AS t
  WHERE t ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  IF v_times IS NULL OR array_length(v_times, 1) NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'Escolha de 1 a 4 horários de postagem (formato 12:00)';
  END IF;
  INSERT INTO public.agency_videomaker_settings (tenant_id, unit_id, slot_times, niche, updated_at)
  VALUES ((v_actor ->> 'tenantId')::UUID, p_unit_id, v_times, LEFT(BTRIM(COALESCE(p_niche, '')), 1500), now())
  ON CONFLICT (tenant_id, unit_id) DO UPDATE
    SET slot_times = EXCLUDED.slot_times, niche = EXCLUDED.niche, updated_at = now();
END;
$$;

-- Registra um video ja enviado ao Storage (caminho <empresa>/<loja>/<video>/...).
-- Ate 40 videos na fila por empresa (sem contar publicados e cancelados).
CREATE OR REPLACE FUNCTION public.register_agency_video(p_unit_id TEXT, p_video JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor JSONB := public.videomaker_actor(p_unit_id);
  v_tenant UUID := (v_actor ->> 'tenantId')::UUID;
  v_id UUID;
  v_prefix TEXT;
  v_path TEXT := p_video ->> 'storagePath';
  v_frames TEXT[];
  v_size BIGINT := COALESCE((p_video ->> 'sizeBytes')::BIGINT, 0);
  v_duration NUMERIC := COALESCE((p_video ->> 'durationSeconds')::NUMERIC, 0);
  v_mime TEXT := COALESCE(p_video ->> 'mimeType', 'video/mp4');
  v_row public.agency_videos;
BEGIN
  BEGIN
    v_id := (p_video ->> 'id')::UUID;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Identificação do vídeo inválida';
  END;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Identificação do vídeo inválida'; END IF;
  IF COALESCE((p_video ->> 'rightsConfirmed')::BOOLEAN, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Confirme que a loja tem direito sobre os vídeos e as músicas';
  END IF;

  v_prefix := v_tenant::TEXT || '/' || p_unit_id || '/' || v_id::TEXT || '/';
  IF v_path IS NULL OR v_path NOT LIKE v_prefix || '%' THEN RAISE EXCEPTION 'Caminho do vídeo inválido'; END IF;
  SELECT COALESCE(array_agg(f), '{}') INTO v_frames
  FROM jsonb_array_elements_text(COALESCE(p_video -> 'framePaths', '[]'::JSONB)) AS f;
  IF EXISTS (SELECT 1 FROM unnest(v_frames) AS f WHERE f NOT LIKE v_prefix || '%') OR array_length(v_frames, 1) > 12 THEN
    RAISE EXCEPTION 'Fotos do vídeo inválidas';
  END IF;
  IF v_mime NOT IN ('video/mp4', 'video/quicktime') THEN RAISE EXCEPTION 'Formato aceito: MP4 ou MOV'; END IF;
  IF v_size <= 0 OR v_size > 314572800 THEN RAISE EXCEPTION 'O vídeo pode ter até 300 MB'; END IF;
  IF v_duration < 3 OR v_duration > 900 THEN RAISE EXCEPTION 'O vídeo precisa ter de 3 segundos a 15 minutos'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('agency_videos:' || v_tenant::TEXT));
  IF (SELECT COUNT(*) FROM public.agency_videos
      WHERE tenant_id = v_tenant AND status NOT IN ('PUBLICADO', 'CANCELADO')) >= 40 THEN
    RAISE EXCEPTION 'A fila já tem 40 vídeos. Espere alguns serem publicados ou exclua algum.';
  END IF;

  INSERT INTO public.agency_videos (
    id, tenant_id, unit_id, position, file_name, storage_path, frame_paths, mime_type, size_bytes,
    duration_seconds, width, height, source, drive_file_id, note, transcript,
    rights_confirmed_by, created_by, created_by_name
  ) VALUES (
    v_id, v_tenant, p_unit_id,
    COALESCE((SELECT MAX(position) FROM public.agency_videos WHERE tenant_id = v_tenant AND unit_id = p_unit_id), 0) + 1,
    LEFT(COALESCE(p_video ->> 'fileName', ''), 200), v_path, v_frames, v_mime, v_size, v_duration,
    NULLIF(p_video ->> 'width', '')::INTEGER, NULLIF(p_video ->> 'height', '')::INTEGER,
    CASE WHEN p_video ->> 'source' = 'DRIVE' THEN 'DRIVE' ELSE 'ARQUIVO' END,
    LEFT(NULLIF(p_video ->> 'driveFileId', ''), 100),
    LEFT(BTRIM(COALESCE(p_video ->> 'note', '')), 500),
    LEFT(COALESCE(p_video ->> 'transcript', ''), 8000),
    auth.uid(), auth.uid(), COALESCE(v_actor ->> 'name', '')
  )
  RETURNING * INTO v_row;
  RETURN public.videomaker_video_json(v_row);
END;
$$;

-- Altera frase, legenda e/ou data. Mudar a legenda de um video aprovado volta para "falta aprovar".
CREATE OR REPLACE FUNCTION public.update_agency_video(p_id UUID, p_changes JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_video public.agency_videos := public.videomaker_lock_video(p_id);
  v_caption TEXT := v_video.caption;
  v_when TIMESTAMPTZ := v_video.scheduled_at;
  v_status TEXT := v_video.status;
  v_row public.agency_videos;
BEGIN
  IF v_video.status NOT IN ('RASCUNHO', 'APROVADO', 'PAUSADO', 'ERRO') THEN
    RAISE EXCEPTION 'Este vídeo não pode mais ser alterado';
  END IF;
  IF p_changes ? 'caption' THEN
    v_caption := COALESCE(p_changes ->> 'caption', '');
    PERFORM public.videomaker_check_caption(v_caption);
    IF v_caption IS DISTINCT FROM v_video.caption AND v_status = 'APROVADO' THEN v_status := 'RASCUNHO'; END IF;
  END IF;
  IF p_changes ? 'scheduledAt' THEN
    v_when := NULLIF(p_changes ->> 'scheduledAt', '')::TIMESTAMPTZ;
    IF v_when IS NOT NULL AND v_when < now() + INTERVAL '2 minutes' AND v_when IS DISTINCT FROM v_video.scheduled_at THEN
      RAISE EXCEPTION 'Escolha uma data e hora no futuro';
    END IF;
    IF v_when IS NULL AND v_status = 'APROVADO' THEN v_status := 'RASCUNHO'; END IF;
  END IF;

  UPDATE public.agency_videos SET
    note = CASE WHEN p_changes ? 'note' THEN LEFT(BTRIM(COALESCE(p_changes ->> 'note', '')), 500) ELSE note END,
    caption = v_caption,
    caption_source = CASE WHEN p_changes ? 'caption' AND v_caption IS DISTINCT FROM v_video.caption THEN 'MANUAL' ELSE caption_source END,
    scheduled_at = v_when,
    status = v_status,
    approved_at = CASE WHEN v_status = 'APROVADO' THEN approved_at ELSE NULL END,
    updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_row;
  RETURN public.videomaker_video_json(v_row);
END;
$$;

-- Acoes: APROVAR | DESAPROVAR | PAUSAR | RETOMAR | CANCELAR | TENTAR_DE_NOVO
CREATE OR REPLACE FUNCTION public.set_agency_video_status(p_id UUID, p_action TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_video public.agency_videos := public.videomaker_lock_video(p_id);
  v_actor JSONB := public.videomaker_actor(v_video.unit_id);
  v_row public.agency_videos;
  v_when TIMESTAMPTZ := v_video.scheduled_at;
BEGIN
  IF p_action IN ('APROVAR', 'RETOMAR', 'TENTAR_DE_NOVO') THEN
    IF p_action = 'APROVAR' AND v_video.status NOT IN ('RASCUNHO', 'PAUSADO', 'ERRO') THEN RAISE EXCEPTION 'Este vídeo não pode ser aprovado agora'; END IF;
    IF p_action = 'RETOMAR' AND v_video.status <> 'PAUSADO' THEN RAISE EXCEPTION 'Este vídeo não está pausado'; END IF;
    IF p_action = 'TENTAR_DE_NOVO' AND v_video.status <> 'ERRO' THEN RAISE EXCEPTION 'Este vídeo não está com erro'; END IF;
    IF v_video.video_deleted_at IS NOT NULL THEN RAISE EXCEPTION 'O arquivo deste vídeo já foi apagado'; END IF;
    IF BTRIM(v_video.caption) = '' THEN RAISE EXCEPTION 'Escreva ou gere a legenda antes de aprovar'; END IF;
    PERFORM public.videomaker_check_caption(v_video.caption);
    -- Tentar de novo com horario vencido: publica na proxima rodada (ate 5 minutos).
    IF p_action = 'TENTAR_DE_NOVO' AND (v_when IS NULL OR v_when < now()) THEN v_when := now(); END IF;
    IF v_when IS NULL THEN RAISE EXCEPTION 'Escolha a data e a hora da postagem'; END IF;
    IF p_action <> 'TENTAR_DE_NOVO' AND v_when < now() + INTERVAL '2 minutes' THEN
      RAISE EXCEPTION 'O horário marcado já passou. Escolha uma nova data e hora.';
    END IF;
    UPDATE public.agency_videos SET
      status = 'APROVADO', scheduled_at = v_when,
      approved_at = now(), approved_by = auth.uid(), approved_by_name = COALESCE(v_actor ->> 'name', ''),
      error_message = NULL, ig_container_id = NULL, updated_at = now()
    WHERE id = p_id RETURNING * INTO v_row;
  ELSIF p_action = 'DESAPROVAR' THEN
    IF v_video.status NOT IN ('APROVADO', 'PAUSADO') THEN RAISE EXCEPTION 'Este vídeo não está aprovado'; END IF;
    UPDATE public.agency_videos SET status = 'RASCUNHO', approved_at = NULL, updated_at = now()
    WHERE id = p_id RETURNING * INTO v_row;
  ELSIF p_action = 'PAUSAR' THEN
    IF v_video.status <> 'APROVADO' THEN RAISE EXCEPTION 'Só um vídeo agendado pode ser pausado'; END IF;
    UPDATE public.agency_videos SET status = 'PAUSADO', updated_at = now()
    WHERE id = p_id RETURNING * INTO v_row;
  ELSIF p_action = 'CANCELAR' THEN
    IF v_video.status IN ('PUBLICANDO', 'PUBLICADO', 'CANCELADO') THEN RAISE EXCEPTION 'Este vídeo não pode ser cancelado'; END IF;
    UPDATE public.agency_videos SET status = 'CANCELADO', updated_at = now()
    WHERE id = p_id RETURNING * INTO v_row;
  ELSE
    RAISE EXCEPTION 'Ação inválida';
  END IF;
  RETURN public.videomaker_video_json(v_row);
END;
$$;

-- Troca a ordem de dois videos (e as datas marcadas deles).
CREATE OR REPLACE FUNCTION public.swap_agency_videos(p_a UUID, p_b UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_a public.agency_videos := public.videomaker_lock_video(p_a);
  v_b public.agency_videos := public.videomaker_lock_video(p_b);
BEGIN
  IF v_a.unit_id <> v_b.unit_id THEN RAISE EXCEPTION 'Os vídeos são de lojas diferentes'; END IF;
  IF v_a.status NOT IN ('RASCUNHO', 'APROVADO', 'PAUSADO', 'ERRO')
     OR v_b.status NOT IN ('RASCUNHO', 'APROVADO', 'PAUSADO', 'ERRO') THEN
    RAISE EXCEPTION 'Só vídeos ainda não publicados mudam de ordem';
  END IF;
  UPDATE public.agency_videos SET position = v_b.position, scheduled_at = v_b.scheduled_at,
    status = CASE WHEN v_b.scheduled_at IS NULL AND status = 'APROVADO' THEN 'RASCUNHO' ELSE status END,
    updated_at = now() WHERE id = p_a;
  UPDATE public.agency_videos SET position = v_a.position, scheduled_at = v_a.scheduled_at,
    status = CASE WHEN v_a.scheduled_at IS NULL AND status = 'APROVADO' THEN 'RASCUNHO' ELSE status END,
    updated_at = now() WHERE id = p_b;
END;
$$;

-- Monta o calendario: os videos na ordem recebida, 1 por dia a partir de p_start, alternando os
-- horarios da loja. Se o 1o horario do 1o dia ja passou (ou falta menos de 10 min), comeca no dia
-- seguinte. Videos aprovados continuam aprovados (so muda a data).
CREATE OR REPLACE FUNCTION public.schedule_agency_videos(p_unit_id TEXT, p_start DATE, p_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor JSONB := public.videomaker_actor(p_unit_id);
  v_tenant UUID := (v_actor ->> 'tenantId')::UUID;
  v_times TEXT[];
  v_start DATE := p_start;
  v_count INTEGER := 0;
  v_id UUID;
  v_index INTEGER := 0;
  v_when TIMESTAMPTZ;
BEGIN
  IF p_start IS NULL OR p_start < (now() AT TIME ZONE 'America/Sao_Paulo')::DATE THEN
    RAISE EXCEPTION 'Escolha uma data de início a partir de hoje';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN RETURN 0; END IF;
  IF array_length(p_ids, 1) > 60 THEN RAISE EXCEPTION 'Vídeos demais'; END IF;
  SELECT COALESCE(slot_times, ARRAY['12:00', '18:00']) INTO v_times
  FROM public.agency_videomaker_settings WHERE tenant_id = v_tenant AND unit_id = p_unit_id;
  v_times := COALESCE(v_times, ARRAY['12:00', '18:00']);

  IF ((v_start + v_times[1]::TIME) AT TIME ZONE 'America/Sao_Paulo') < now() + INTERVAL '10 minutes' THEN
    v_start := v_start + 1;
  END IF;

  PERFORM 1 FROM public.agency_videos
  WHERE id = ANY (p_ids) AND tenant_id = v_tenant AND unit_id = p_unit_id
  FOR UPDATE;

  FOREACH v_id IN ARRAY p_ids LOOP
    v_when := ((v_start + v_index) + v_times[(v_index % array_length(v_times, 1)) + 1]::TIME) AT TIME ZONE 'America/Sao_Paulo';
    UPDATE public.agency_videos
    SET position = v_index + 1, scheduled_at = v_when, updated_at = now()
    WHERE id = v_id AND tenant_id = v_tenant AND unit_id = p_unit_id
      AND status IN ('RASCUNHO', 'APROVADO', 'PAUSADO', 'ERRO');
    IF FOUND THEN
      v_count := v_count + 1;
      v_index := v_index + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Apaga o registro do video e devolve os arquivos para o ERP apagar do Storage.
CREATE OR REPLACE FUNCTION public.delete_agency_video(p_id UUID)
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_video public.agency_videos := public.videomaker_lock_video(p_id);
BEGIN
  IF v_video.status = 'PUBLICANDO' THEN RAISE EXCEPTION 'Este vídeo está sendo publicado agora. Tente em alguns minutos.'; END IF;
  DELETE FROM public.agency_videos WHERE id = p_id;
  RETURN array_prepend(v_video.storage_path, v_video.frame_paths);
END;
$$;

-- Desliga o Instagram da loja (so o dono). Videos agendados ficam pausados.
CREATE OR REPLACE FUNCTION public.disconnect_agency_instagram(p_unit_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor JSONB := public.videomaker_actor(p_unit_id);
  v_tenant UUID := (v_actor ->> 'tenantId')::UUID;
BEGIN
  IF NOT (v_actor ->> 'isOwner')::BOOLEAN THEN RAISE EXCEPTION 'Só o dono da empresa conecta ou desconecta o Instagram'; END IF;
  DELETE FROM public.agency_instagram_accounts WHERE tenant_id = v_tenant AND unit_id = p_unit_id;
  UPDATE public.agency_videos SET status = 'PAUSADO', updated_at = now()
  WHERE tenant_id = v_tenant AND unit_id = p_unit_id AND status = 'APROVADO';
END;
$$;

-- Sino "Precisa de atencao": videos com erro e Instagram que precisa conectar de novo (por loja).
CREATE OR REPLACE FUNCTION public.list_videomaker_alerts()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_access JSONB;
  v_tenant UUID;
BEGIN
  IF auth.uid() IS NULL THEN RETURN '[]'::JSONB; END IF;
  v_access := public.agency_access_of(auth.uid());
  IF NOT COALESCE((v_access ->> 'ok')::BOOLEAN, false) AND COALESCE(v_access ->> 'reason', '') <> 'LIMITE' THEN
    RETURN '[]'::JSONB;
  END IF;
  v_tenant := (v_access ->> 'tenantId')::UUID;
  RETURN COALESCE((
    SELECT jsonb_agg(row_data)
    FROM (
      SELECT jsonb_build_object('unitId', s.unit_id,
        'errors', (SELECT COUNT(*) FROM public.agency_videos v WHERE v.tenant_id = v_tenant AND v.unit_id = s.unit_id AND v.status = 'ERRO'),
        'errorNames', (SELECT string_agg(file_name, ', ') FROM (SELECT v.file_name FROM public.agency_videos v
            WHERE v.tenant_id = v_tenant AND v.unit_id = s.unit_id AND v.status = 'ERRO' ORDER BY v.updated_at DESC LIMIT 4) n),
        'expired', EXISTS (SELECT 1 FROM public.agency_instagram_accounts a WHERE a.tenant_id = v_tenant AND a.unit_id = s.unit_id
            AND (a.status = 'EXPIRADA' OR a.token_expires_at <= now())),
        'nextAt', (SELECT MAX(v.scheduled_at) FROM public.agency_videos v WHERE v.tenant_id = v_tenant AND v.unit_id = s.unit_id
            AND v.status = 'APROVADO'),
        'queued', (SELECT COUNT(*) FROM public.agency_videos v WHERE v.tenant_id = v_tenant AND v.unit_id = s.unit_id
            AND v.status IN ('APROVADO', 'RASCUNHO'))
      ) AS row_data
      FROM public.store_configs s
      WHERE s.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, s.unit_id)
        AND EXISTS (SELECT 1 FROM public.agency_videos v WHERE v.tenant_id = v_tenant AND v.unit_id = s.unit_id
          UNION ALL SELECT 1 FROM public.agency_instagram_accounts a WHERE a.tenant_id = v_tenant AND a.unit_id = s.unit_id)
    ) q
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.get_videomaker_state(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_videomaker_settings(TEXT, TEXT[], TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_agency_video(TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_agency_video(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_agency_video_status(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.swap_agency_videos(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.schedule_agency_videos(TEXT, DATE, UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_agency_video(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.disconnect_agency_instagram(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_videomaker_alerts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_videomaker_state(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_videomaker_settings(TEXT, TEXT[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_agency_video(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_agency_video(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_agency_video_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.swap_agency_videos(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_agency_videos(TEXT, DATE, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_agency_video(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.disconnect_agency_instagram(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_videomaker_alerts() TO authenticated;

-- ---------------- Servidor (Edge Function agency-videomaker) ----------------
-- Separa os videos que chegaram na hora (ate 10 por rodada) e marca como PUBLICANDO.
-- Empresa bloqueada, Agencia desligada ou horario vencido ha mais de 12 h viram ERRO.
CREATE OR REPLACE FUNCTION public.agency_videomaker_claim_due()
RETURNS SETOF public.agency_videos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.agency_videos v SET
    status = 'ERRO',
    error_message = CASE
      WHEN v.scheduled_at < now() - INTERVAL '12 hours' THEN 'O horário passou sem publicar. Escolha uma nova data e hora e aprove de novo.'
      ELSE 'A Agência está desligada ou a assinatura da empresa está bloqueada.'
    END,
    updated_at = now()
  FROM public.tenants t
  WHERE t.id = v.tenant_id AND v.status = 'APROVADO' AND v.scheduled_at <= now()
    AND (v.scheduled_at < now() - INTERVAL '12 hours'
      OR NOT t.agency_enabled
      OR COALESCE(t.subscription_status, 'ATIVO') IN ('BLOQUEADO', 'CANCELADO'));

  RETURN QUERY
  WITH claimed AS (
    UPDATE public.agency_videos v SET
      status = 'PUBLICANDO', publish_started_at = now(), attempts = v.attempts + 1,
      ig_container_id = NULL, error_message = NULL, updated_at = now()
    WHERE v.id IN (
      SELECT id FROM public.agency_videos
      WHERE status = 'APROVADO' AND scheduled_at <= now()
      ORDER BY scheduled_at
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    )
    RETURNING v.*
  )
  SELECT * FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.agency_videomaker_claim_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agency_videomaker_claim_due() TO service_role;

-- ---------------- Arquivos (bucket privado) ----------------
-- <empresa>/<loja>/<video>/video.mp4 e f1.jpg ... f8.jpg. Tamanho maximo por arquivo: o do plano
-- do Supabase (o ERP confere 300 MB antes de enviar).
INSERT INTO storage.buckets (id, name, public, allowed_mime_types)
VALUES ('agency-videos', 'agency-videos', false, ARRAY['video/mp4', 'video/quicktime', 'image/jpeg'])
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.agency_video_file_allowed(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant TEXT := split_part(p_name, '/', 1);
  v_unit TEXT := split_part(p_name, '/', 2);
  v_video TEXT := split_part(p_name, '/', 3);
BEGIN
  IF auth.uid() IS NULL
     OR v_tenant <> COALESCE(public.current_user_tenant_id()::TEXT, '')
     OR v_video !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  PERFORM public.videomaker_actor(v_unit);
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.agency_video_file_allowed(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agency_video_file_allowed(TEXT) TO authenticated;

DROP POLICY IF EXISTS agency_videos_read ON storage.objects;
CREATE POLICY agency_videos_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'agency-videos' AND public.agency_video_file_allowed(name));

DROP POLICY IF EXISTS agency_videos_insert ON storage.objects;
CREATE POLICY agency_videos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'agency-videos' AND public.agency_video_file_allowed(name));

DROP POLICY IF EXISTS agency_videos_update ON storage.objects;
CREATE POLICY agency_videos_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'agency-videos' AND public.agency_video_file_allowed(name));

DROP POLICY IF EXISTS agency_videos_delete ON storage.objects;
CREATE POLICY agency_videos_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'agency-videos' AND public.agency_video_file_allowed(name));

-- ---------------- Agendador: a cada 5 minutos chama a Edge Function ----------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agency-videomaker') THEN
    PERFORM cron.unschedule('agency-videomaker');
  END IF;
END $$;

SELECT cron.schedule(
  'agency-videomaker',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://qnxmboxwluuyjvgiqlbm.supabase.co/functions/v1/agency-videomaker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-videomaker-cron', (SELECT secret FROM public.agency_videomaker_cron WHERE id = 1)
    ),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
