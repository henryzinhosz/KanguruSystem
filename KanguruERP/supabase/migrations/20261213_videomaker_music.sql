-- Agencia de IA, etapa C: musica nos Reels do VideoMaker (desenho aprovado em 2026-11-26).
-- Aditiva: so colunas novas em agency_videos, uma funcao nova (set_agency_video_music) e a troca de
-- videomaker_video_json (mesma assinatura, so acrescenta campos).
--
-- Como funciona:
-- - A musica vem da biblioteca do Instagram (API de Audio da Meta, so musicas liberadas para uso);
--   a busca passa pela Edge Function agency-videomaker (a chave do Instagram nao sai do servidor).
-- - Na hora de postar, o Instagram junta a musica ao video (audio_configuration). Volumes de 1 a 100.
-- - "Tirar o som original": posta a COPIA MUDA do video (silent_path) com a musica por cima.
-- - Musica indisponivel na hora de postar: posta a copia muda SEM musica e marca music_dropped_at
--   (o cartao avisa). Video sem faixa de audio: silent_path = storage_path (ja e mudo).
-- - A copia muda e feita no navegador (tira a faixa de audio do MP4/MOV, sem recomprimir) e fica
--   em <empresa>/<loja>/<video>/silent.mp4 (ou .mov).
--
-- ANTES DE APLICAR, conferir que videomaker_video_json e a da 20261212:
--   select md5(prosrc) from pg_proc where proname = 'videomaker_video_json';
--   esperado: d9bf913b166a112466125e1b33b7bf54 (LF) ou fc079a066c4a52125efe6fdea65bd4bb (CRLF)
--   Se nao bater, PARAR.

ALTER TABLE public.agency_videos
  ADD COLUMN IF NOT EXISTS music_audio_id TEXT,
  ADD COLUMN IF NOT EXISTS music_title TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS music_artist TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS music_cover_url TEXT,
  ADD COLUMN IF NOT EXISTS music_duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS music_volume INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS video_volume INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS mute_original BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS silent_path TEXT,
  ADD COLUMN IF NOT EXISTS music_dropped_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agency_videos_music_volume_check') THEN
    ALTER TABLE public.agency_videos ADD CONSTRAINT agency_videos_music_volume_check CHECK (music_volume BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agency_videos_video_volume_check') THEN
    ALTER TABLE public.agency_videos ADD CONSTRAINT agency_videos_video_volume_check CHECK (video_volume BETWEEN 1 AND 100);
  END IF;
END $$;

-- Mesma funcao da 20261212 + musica, copia muda e aviso de musica que saiu.
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
    'createdAt', v.created_at,
    'music', CASE WHEN v.music_audio_id IS NULL THEN NULL ELSE jsonb_build_object(
      'audioId', v.music_audio_id,
      'title', v.music_title,
      'artist', v.music_artist,
      'coverUrl', v.music_cover_url,
      'durationMs', v.music_duration_ms,
      'musicVolume', v.music_volume,
      'videoVolume', v.video_volume,
      'muteOriginal', v.mute_original
    ) END,
    'silentPath', v.silent_path,
    'musicDroppedAt', v.music_dropped_at
  );
$$;

REVOKE ALL ON FUNCTION public.videomaker_video_json(public.agency_videos) FROM PUBLIC, anon, authenticated;

-- Escolhe, troca ou tira a musica de um video ainda nao publicado.
-- p_music: { audioId, title, artist, coverUrl, durationMs, musicVolume, videoVolume, muteOriginal,
--            silentPath } ou null para tirar a musica (a copia muda fica guardada para reuso).
-- Mudar a musica de um video aprovado volta para "falta aprovar" (igual a legenda).
CREATE OR REPLACE FUNCTION public.set_agency_video_music(p_id UUID, p_music JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_video public.agency_videos := public.videomaker_lock_video(p_id);
  v_prefix TEXT := v_video.tenant_id::TEXT || '/' || v_video.unit_id || '/' || v_video.id::TEXT || '/';
  v_audio TEXT;
  v_music_volume INTEGER := 100;
  v_video_volume INTEGER := 100;
  v_mute BOOLEAN := false;
  v_silent TEXT := v_video.silent_path;
  v_cover TEXT;
  v_status TEXT := v_video.status;
  v_row public.agency_videos;
BEGIN
  IF v_video.status NOT IN ('RASCUNHO', 'APROVADO', 'PAUSADO', 'ERRO') THEN
    RAISE EXCEPTION 'Este vídeo não pode mais ser alterado';
  END IF;

  IF p_music IS NOT NULL AND jsonb_typeof(p_music) = 'object' THEN
    v_audio := NULLIF(BTRIM(COALESCE(p_music ->> 'audioId', '')), '');
  END IF;

  IF v_audio IS NOT NULL THEN
    IF v_audio !~ '^[0-9A-Za-z_-]{1,64}$' THEN RAISE EXCEPTION 'Música inválida'; END IF;
    BEGIN
      v_music_volume := COALESCE((p_music ->> 'musicVolume')::INTEGER, 100);
      v_video_volume := COALESCE((p_music ->> 'videoVolume')::INTEGER, 100);
      v_mute := COALESCE((p_music ->> 'muteOriginal')::BOOLEAN, false);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Volumes inválidos';
    END;
    IF v_music_volume NOT BETWEEN 1 AND 100 OR v_video_volume NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'Os volumes vão de 1 a 100';
    END IF;
    IF p_music ? 'silentPath' THEN
      v_silent := NULLIF(p_music ->> 'silentPath', '');
      IF v_silent IS NOT NULL AND v_silent <> v_video.storage_path
         AND v_silent NOT IN (v_prefix || 'silent.mp4', v_prefix || 'silent.mov') THEN
        RAISE EXCEPTION 'Cópia sem som inválida';
      END IF;
    END IF;
    v_cover := NULLIF(p_music ->> 'coverUrl', '');
    IF v_cover IS NOT NULL AND v_cover !~ '^https://' THEN v_cover := NULL; END IF;
  END IF;

  IF v_status = 'APROVADO' AND (
       v_audio IS DISTINCT FROM v_video.music_audio_id
       OR (v_audio IS NOT NULL AND (v_music_volume <> v_video.music_volume OR v_video_volume <> v_video.video_volume OR v_mute <> v_video.mute_original))
     ) THEN
    v_status := 'RASCUNHO';
  END IF;

  UPDATE public.agency_videos SET
    music_audio_id = v_audio,
    music_title = CASE WHEN v_audio IS NULL THEN '' ELSE LEFT(BTRIM(COALESCE(p_music ->> 'title', '')), 200) END,
    music_artist = CASE WHEN v_audio IS NULL THEN '' ELSE LEFT(BTRIM(COALESCE(p_music ->> 'artist', '')), 200) END,
    music_cover_url = CASE WHEN v_audio IS NULL THEN NULL ELSE LEFT(v_cover, 2000) END,
    music_duration_ms = CASE WHEN v_audio IS NULL THEN NULL ELSE NULLIF(p_music ->> 'durationMs', '')::NUMERIC::INTEGER END,
    music_volume = v_music_volume,
    video_volume = v_video_volume,
    mute_original = v_mute,
    silent_path = v_silent,
    music_dropped_at = NULL,
    status = v_status,
    approved_at = CASE WHEN v_status = 'APROVADO' THEN approved_at ELSE NULL END,
    updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_row;
  RETURN public.videomaker_video_json(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.set_agency_video_music(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_agency_video_music(UUID, JSONB) TO authenticated;
