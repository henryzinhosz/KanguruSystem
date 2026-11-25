import * as tus from 'tus-js-client';
import { getSupabaseConfig, supabase } from './supabaseClient';

// VideoMaker da Agência (migration 20261212, Edge Function agency-videomaker).

export const VIDEO_BUCKET = 'agency-videos';
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
export const MAX_ACTIVE_VIDEOS = 40;

export type VideoStatus = 'RASCUNHO' | 'APROVADO' | 'PUBLICANDO' | 'PUBLICADO' | 'ERRO' | 'PAUSADO' | 'CANCELADO';

export interface AgencyVideo {
  id: string;
  unitId: string;
  position: number;
  fileName: string;
  storagePath: string;
  framePaths: string[];
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  source: 'ARQUIVO' | 'DRIVE';
  note: string;
  transcript: string;
  caption: string;
  captionSource: '' | 'IA' | 'TESTE' | 'MANUAL';
  captionAt: string | null;
  scheduledAt: string | null;
  status: VideoStatus;
  approvedAt: string | null;
  approvedByName: string;
  permalink: string | null;
  publishedAt: string | null;
  errorMessage: string | null;
  attempts: number;
  videoDeleted: boolean;
  createdByName: string;
  createdAt: string;
}

export interface InstagramAccount {
  username: string;
  status: 'ATIVA' | 'EXPIRADA';
  expiresAt: string;
  lastError: string | null;
  connectedByName: string;
  connectedAt: string;
}

export interface VideoMakerState {
  isOwner: boolean;
  captionOk: boolean;
  reason: string | null;
  used: number;
  limit: number;
  maxActive: number;
  account: InstagramAccount | null;
  settings: { slotTimes: string[]; niche: string };
  videos: AgencyVideo[];
}

export const VIDEO_STATUS_LABELS: Record<VideoStatus, string> = {
  RASCUNHO: 'Falta aprovar',
  APROVADO: 'Agendado',
  PUBLICANDO: 'Publicando',
  PUBLICADO: 'Publicado',
  ERRO: 'Erro',
  PAUSADO: 'Pausado',
  CANCELADO: 'Cancelado',
};

export const EDITABLE_STATUSES: VideoStatus[] = ['RASCUNHO', 'APROVADO', 'PAUSADO', 'ERRO'];

const toVideo = (raw: Record<string, unknown>): AgencyVideo => ({
  id: String(raw.id),
  unitId: String(raw.unitId ?? ''),
  position: Number(raw.position ?? 0),
  fileName: String(raw.fileName ?? ''),
  storagePath: String(raw.storagePath ?? ''),
  framePaths: Array.isArray(raw.framePaths) ? (raw.framePaths as string[]) : [],
  mimeType: String(raw.mimeType ?? 'video/mp4'),
  sizeBytes: Number(raw.sizeBytes ?? 0),
  durationSeconds: Number(raw.durationSeconds ?? 0),
  width: raw.width == null ? null : Number(raw.width),
  height: raw.height == null ? null : Number(raw.height),
  source: raw.source === 'DRIVE' ? 'DRIVE' : 'ARQUIVO',
  note: String(raw.note ?? ''),
  transcript: String(raw.transcript ?? ''),
  caption: String(raw.caption ?? ''),
  captionSource: (raw.captionSource as AgencyVideo['captionSource']) ?? '',
  captionAt: (raw.captionAt as string) ?? null,
  scheduledAt: (raw.scheduledAt as string) ?? null,
  status: raw.status as VideoStatus,
  approvedAt: (raw.approvedAt as string) ?? null,
  approvedByName: String(raw.approvedByName ?? ''),
  permalink: (raw.permalink as string) ?? null,
  publishedAt: (raw.publishedAt as string) ?? null,
  errorMessage: (raw.errorMessage as string) ?? null,
  attempts: Number(raw.attempts ?? 0),
  videoDeleted: Boolean(raw.videoDeleted),
  createdByName: String(raw.createdByName ?? ''),
  createdAt: String(raw.createdAt ?? ''),
});

// Mensagem do banco sem o prefixo técnico.
const clean = (error: { message?: string } | null) => {
  const message = error?.message || 'Não foi possível concluir.';
  return new Error(message.replace(/^.*?ERROR:\s*/, ''));
};

export async function getVideoMakerState(unitId: string): Promise<VideoMakerState | null> {
  const { data, error } = await supabase.rpc('get_videomaker_state', { p_unit_id: unitId });
  if (error) {
    // Migration ainda não aplicada: o VideoMaker fica escondido.
    if (/get_videomaker_state/.test(error.message || '')) return null;
    throw clean(error);
  }
  const raw = (data || {}) as Record<string, unknown>;
  const settings = (raw.settings || {}) as Record<string, unknown>;
  return {
    isOwner: Boolean(raw.isOwner),
    captionOk: Boolean(raw.captionOk),
    reason: (raw.reason as string) ?? null,
    used: Number(raw.used ?? 0),
    limit: Number(raw.limit ?? 0),
    maxActive: Number(raw.maxActive ?? MAX_ACTIVE_VIDEOS),
    account: (raw.account as InstagramAccount) ?? null,
    settings: {
      slotTimes: Array.isArray(settings.slotTimes) ? (settings.slotTimes as string[]) : ['12:00', '18:00'],
      niche: String(settings.niche ?? ''),
    },
    videos: Array.isArray(raw.videos) ? (raw.videos as Record<string, unknown>[]).map(toVideo) : [],
  };
}

export async function saveVideoMakerSettings(unitId: string, slotTimes: string[], niche: string): Promise<void> {
  const { error } = await supabase.rpc('save_videomaker_settings', { p_unit_id: unitId, p_slot_times: slotTimes, p_niche: niche });
  if (error) throw clean(error);
}

export interface RegisterVideoInput {
  id: string;
  fileName: string;
  storagePath: string;
  framePaths: string[];
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  source: 'ARQUIVO' | 'DRIVE';
  driveFileId?: string | null;
  note: string;
  transcript: string;
  rightsConfirmed: boolean;
}

export async function registerAgencyVideo(unitId: string, video: RegisterVideoInput): Promise<AgencyVideo> {
  const { data, error } = await supabase.rpc('register_agency_video', { p_unit_id: unitId, p_video: video });
  if (error) throw clean(error);
  return toVideo(data as Record<string, unknown>);
}

export async function updateAgencyVideo(id: string, changes: { note?: string; caption?: string; scheduledAt?: string | null }): Promise<AgencyVideo> {
  const { data, error } = await supabase.rpc('update_agency_video', { p_id: id, p_changes: changes });
  if (error) throw clean(error);
  return toVideo(data as Record<string, unknown>);
}

export type VideoAction = 'APROVAR' | 'DESAPROVAR' | 'PAUSAR' | 'RETOMAR' | 'CANCELAR' | 'TENTAR_DE_NOVO';

export async function setAgencyVideoStatus(id: string, action: VideoAction): Promise<AgencyVideo> {
  const { data, error } = await supabase.rpc('set_agency_video_status', { p_id: id, p_action: action });
  if (error) throw clean(error);
  return toVideo(data as Record<string, unknown>);
}

export async function swapAgencyVideos(a: string, b: string): Promise<void> {
  const { error } = await supabase.rpc('swap_agency_videos', { p_a: a, p_b: b });
  if (error) throw clean(error);
}

export async function scheduleAgencyVideos(unitId: string, start: string, ids: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('schedule_agency_videos', { p_unit_id: unitId, p_start: start, p_ids: ids });
  if (error) throw clean(error);
  return Number(data ?? 0);
}

export async function deleteAgencyVideo(id: string): Promise<void> {
  const { data, error } = await supabase.rpc('delete_agency_video', { p_id: id });
  if (error) throw clean(error);
  const paths = ((data as string[]) || []).filter(Boolean);
  if (paths.length) await supabase.storage.from(VIDEO_BUCKET).remove(paths);
}

export async function disconnectInstagram(unitId: string): Promise<void> {
  const { error } = await supabase.rpc('disconnect_agency_instagram', { p_unit_id: unitId });
  if (error) throw clean(error);
}

// Links temporários (1 hora) para as miniaturas e para assistir o vídeo.
export async function signedVideoUrls(paths: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(paths.filter(Boolean)));
  if (unique.length === 0) return {};
  const { data, error } = await supabase.storage.from(VIDEO_BUCKET).createSignedUrls(unique, 3600);
  if (error) return {};
  const result: Record<string, string> = {};
  (data || []).forEach(item => { if (item.path && item.signedUrl) result[item.path] = item.signedUrl; });
  return result;
}

// ---------------- Edge Function ----------------
async function callFunction<T>(body: Record<string, unknown>): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Sessão expirada. Entre de novo.');
  const { url, anonKey } = getSupabaseConfig();
  const response = await fetch(`${url}/functions/v1/agency-videomaker`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let result: Record<string, unknown> = {};
  try {
    result = await response.json();
  } catch {
    // sem corpo
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error('O VideoMaker ainda não foi publicado no servidor.');
    throw new Error(String(result.error || 'Não foi possível falar com o VideoMaker agora.'));
  }
  return result as T;
}

// Endereço do login do Instagram (só o dono). O ERP abre nesta mesma aba.
export async function startInstagramConnect(unitId: string): Promise<string> {
  const result = await callFunction<{ url: string }>({ action: 'connect', unitId, returnTo: window.location.origin });
  return result.url;
}

export async function generateCaption(unitId: string, videoId: string): Promise<{ caption: string; source: string; used: number; limit: number }> {
  return callFunction({ action: 'caption', unitId, videoId });
}

// ---------------- Envio de arquivos (retomável, com progresso) ----------------
export async function uploadVideoFile(path: string, file: Blob, contentType: string, onProgress?: (fraction: number) => void): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Sessão expirada. Entre de novo.');
  const { url, anonKey } = getSupabaseConfig();
  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${url}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: { authorization: `Bearer ${token}`, apikey: anonKey, 'x-upsert': 'true' },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: { bucketName: VIDEO_BUCKET, objectName: path, contentType, cacheControl: '3600' },
      chunkSize: 6 * 1024 * 1024,
      onError: error => {
        const message = String((error as Error)?.message || '');
        if (/413|too large|maximum allowed size/i.test(message)) {
          reject(new Error('O arquivo passou do tamanho máximo aceito pelo armazenamento do Kanguru (plano do Supabase).'));
        } else if (/403|row-level security|unauthorized/i.test(message)) {
          reject(new Error('Sem permissão para enviar vídeos desta loja.'));
        } else {
          reject(new Error('O envio do vídeo falhou. Confira a internet e tente de novo.'));
        }
      },
      onProgress: (sent, total) => onProgress?.(total ? sent / total : 0),
      onSuccess: () => resolve(),
    });
    upload.start();
  });
}

export async function uploadSmallFile(path: string, file: Blob, contentType: string): Promise<void> {
  const { error } = await supabase.storage.from(VIDEO_BUCKET).upload(path, file, { contentType, upsert: true });
  if (error) throw new Error('Não foi possível enviar as fotos do vídeo.');
}

export async function removeVideoFiles(paths: string[]): Promise<void> {
  if (paths.length) await supabase.storage.from(VIDEO_BUCKET).remove(paths).catch(() => undefined);
}

// ---------------- Sino "Precisa de atenção" ----------------
export interface VideoMakerAlertRow {
  unitId: string;
  errors: number;
  errorNames: string | null;
  expired: boolean;
  nextAt: string | null;
  queued: number;
}

export async function listVideoMakerAlerts(): Promise<VideoMakerAlertRow[]> {
  const { data, error } = await supabase.rpc('list_videomaker_alerts');
  if (error) return [];
  return ((data || []) as Record<string, unknown>[]).map(row => ({
    unitId: String(row.unitId ?? ''),
    errors: Number(row.errors ?? 0),
    errorNames: (row.errorNames as string) ?? null,
    expired: Boolean(row.expired),
    nextAt: (row.nextAt as string) ?? null,
    queued: Number(row.queued ?? 0),
  }));
}

// Hashtags e caracteres da legenda (regras do Instagram: 2.200 e 30).
export const captionStats = (caption: string) => ({
  chars: caption.length,
  hashtags: (caption.match(/#[^\s#]+/g) || []).length,
});
