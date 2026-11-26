import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, AtSign, CalendarDays, Check, ExternalLink, Eye, Film, FolderOpen,
  Loader2, Pause, Play, Plus, RotateCcw, Sparkles, Trash2, Undo2, Upload, X,
} from 'lucide-react';
import type { StoreConfig, User } from '../../types';
import {
  EDITABLE_STATUSES, MAX_VIDEO_BYTES, MAX_VIDEO_MB, VIDEO_STATUS_LABELS, captionStats, deleteAgencyVideo, disconnectInstagram,
  generateCaption, getVideoMakerState, registerAgencyVideo, removeVideoFiles, saveVideoMakerSettings, scheduleAgencyVideos,
  setAgencyVideoStatus, signedVideoUrls, startInstagramConnect, swapAgencyVideos, updateAgencyVideo, uploadSmallFile,
  uploadVideoFile, type AgencyVideo, type VideoAction, type VideoMakerState, type VideoStatus,
} from '../../db/videoMaker';
import { extractAudio, extractFrames, probeVideo, transcribe } from './videoProcessing';
import { downloadDriveVideo, driveImportAvailable, listDriveFolderVideos, type DriveVideo } from './driveImport';

// VideoMaker (Agência › Marketing): sobe vídeos, a IA escreve a legenda, o franqueado aprova e o
// servidor publica no Instagram da loja no dia e hora marcados (1 por dia, alternando horários).

interface Props {
  currentUser: User;
  stores: StoreConfig[];
  unitId: string;
  onUnitChange: (unitId: string) => void;
  onBack: () => void;
  onBusyChange: (busy: boolean) => void;
  // Mensagem da volta do login do Instagram.
  notice: { ok: boolean; text: string } | null;
  onNoticeClose: () => void;
  onUsage: (used: number, limit: number) => void;
}

interface QueueItem {
  key: string;
  name: string;
  file?: File;
  drive?: DriveVideo;
  step: string;
  progress: number | null;
  done: boolean;
  error?: string;
  warning?: string;
}

const PANEL = { background: '#0f1a2c', borderColor: '#5b7fa8', boxShadow: '4px 4px 0 #070b14' };
const INPUT = 'w-full rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-blue-400 disabled:opacity-60';
const BUTTON = 'inline-flex items-center justify-center gap-1.5 rounded border-2 px-2.5 py-1.5 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-50';
const BLUE = { background: '#0c1a33', borderColor: '#60a5fa', color: '#bfdbfe' };
const GREEN = { background: '#0b2418', borderColor: '#4ade80', color: '#bbf7d0' };
const RED = { background: '#2a0f14', borderColor: '#f87171', color: '#fecaca' };
const GREY = { background: '#111827', borderColor: '#475569', color: '#cbd5e1' };

const STATUS_LOOK: Record<VideoStatus, { color: string; bg: string; border: string }> = {
  RASCUNHO: { color: '#fde047', bg: '#2b260c', border: '#a16207' },
  APROVADO: { color: '#86efac', bg: '#0f2a1c', border: '#2f6b47' },
  PUBLICANDO: { color: '#93c5fd', bg: '#0c1a33', border: '#1d4ed8' },
  PUBLICADO: { color: '#e2e8f0', bg: '#1e293b', border: '#475569' },
  ERRO: { color: '#fecaca', bg: '#3b0d12', border: '#b91c1c' },
  PAUSADO: { color: '#cbd5e1', bg: '#151c28', border: '#334155' },
  CANCELADO: { color: '#94a3b8', bg: '#151c28', border: '#334155' },
};

const errorText = (error: unknown, fallback: string) => (error as { message?: string })?.message || fallback;
const pad = (value: number) => String(value).padStart(2, '0');
const todayKey = () => { const now = new Date(); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; };
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const formatWhen = (iso: string | null) => iso
  ? new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : 'sem data';
const formatSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const formatDuration = (seconds: number) => {
  const total = Math.round(seconds);
  return total >= 60 ? `${Math.floor(total / 60)}min${pad(total % 60)}s` : `${total}s`;
};
const mimeOf = (file: File): string | null => {
  const name = file.name.toLowerCase();
  if (file.type === 'video/quicktime' || name.endsWith('.mov')) return 'video/quicktime';
  if (file.type === 'video/mp4' || name.endsWith('.mp4') || name.endsWith('.m4v')) return 'video/mp4';
  return null;
};

function StatusChip({ status }: { status: VideoStatus }) {
  const look = STATUS_LOOK[status];
  return (
    <span className="whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-bold" style={{ color: look.color, background: look.bg, borderColor: look.border }}>
      {VIDEO_STATUS_LABELS[status]}
    </span>
  );
}

interface CardProps {
  key?: string;
  video: AgencyVideo;
  thumb: string | undefined;
  busy: boolean;
  canCaption: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onAction: (video: AgencyVideo, action: VideoAction) => void;
  onSave: (video: AgencyVideo, changes: { note?: string; caption?: string; scheduledAt?: string | null }) => Promise<void>;
  onCaption: (video: AgencyVideo) => void;
  onMove: (video: AgencyVideo, direction: -1 | 1) => void;
  onWatch: (video: AgencyVideo) => void;
  onDelete: (video: AgencyVideo) => void;
}

function VideoCard({ video, thumb, busy, canCaption, canMoveUp, canMoveDown, onAction, onSave, onCaption, onMove, onWatch, onDelete }: CardProps) {
  const editable = EDITABLE_STATUSES.includes(video.status);
  const [caption, setCaption] = useState(video.caption);
  const [note, setNote] = useState(video.note);
  const [showTranscript, setShowTranscript] = useState(false);
  useEffect(() => setCaption(video.caption), [video.caption]);
  useEffect(() => setNote(video.note), [video.note]);
  const stats = captionStats(caption);
  const captionDirty = caption !== video.caption;
  const vertical = video.width && video.height ? video.height > video.width : null;

  return (
    <article className="flex flex-col gap-3 rounded-lg border-2 p-3 sm:flex-row" style={{ background: '#0b1424', borderColor: video.status === 'ERRO' ? '#b91c1c' : '#22344f' }}>
      <div className="flex shrink-0 flex-row gap-2 sm:flex-col sm:items-center">
        <div className="relative h-[142px] w-[80px] overflow-hidden rounded border border-slate-700 bg-slate-900">
          {thumb
            ? <img src={thumb} alt="" className="h-full w-full object-cover" />
            : <div className="flex h-full items-center justify-center text-slate-600"><Film className="h-6 w-6" /></div>}
          <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-bold text-white">#{video.position}</span>
        </div>
        {editable && (
          <div className="flex gap-1 sm:flex-row">
            <button type="button" disabled={busy || !canMoveUp} onClick={() => onMove(video, -1)} title="Passar para antes (troca as datas)" aria-label="Mover para cima" className={BUTTON} style={GREY}><ArrowUp className="h-3.5 w-3.5" /></button>
            <button type="button" disabled={busy || !canMoveDown} onClick={() => onMove(video, 1)} title="Passar para depois (troca as datas)" aria-label="Mover para baixo" className={BUTTON} style={GREY}><ArrowDown className="h-3.5 w-3.5" /></button>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={video.status} />
          <span className="min-w-0 truncate text-sm font-semibold text-slate-100" title={video.fileName}>{video.fileName}</span>
          <span className="text-xs text-slate-400">{formatDuration(video.durationSeconds)} · {formatSize(video.sizeBytes)}{video.source === 'DRIVE' ? ' · Drive' : ''}</span>
          {vertical === false && <span className="text-[11px] font-semibold text-amber-300" title="O Instagram recomenda vídeo em pé (9:16)">vídeo deitado</span>}
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" />}
        </div>

        {video.errorMessage && video.status === 'ERRO' && (
          <p className="flex items-start gap-1.5 rounded border border-red-800 bg-red-950/60 px-2 py-1.5 text-xs text-red-200"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{video.errorMessage}</p>
        )}

        <div className="grid gap-2 md:grid-cols-[220px_minmax(0,1fr)]">
          <label className="block text-xs text-slate-300">
            Postar em
            {editable ? (
              <input
                type="datetime-local"
                value={toLocalInput(video.scheduledAt)}
                disabled={busy}
                onChange={event => { const value = event.target.value; void onSave(video, { scheduledAt: value ? new Date(value).toISOString() : null }); }}
                className={`${INPUT} mt-1`}
              />
            ) : (
              <span className="mt-1 block text-sm text-slate-100">{video.status === 'PUBLICADO' ? `Publicado ${formatWhen(video.publishedAt)}` : formatWhen(video.scheduledAt)}</span>
            )}
          </label>
          <label className="block text-xs text-slate-300">
            Frase sobre o vídeo (opcional, orienta a IA)
            <input
              value={note}
              maxLength={500}
              disabled={!editable || busy}
              onChange={event => setNote(event.target.value)}
              onBlur={() => { if (note !== video.note) void onSave(video, { note }); }}
              placeholder='Ex.: "chegou o controle DualSense branco"'
              className={`${INPUT} mt-1`}
            />
          </label>
        </div>

        <label className="block text-xs text-slate-300">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>Legenda{video.captionSource === 'IA' ? ' (escrita pela IA)' : video.captionSource === 'TESTE' ? ' (modo de teste)' : video.captionSource === 'MANUAL' ? ' (editada)' : ''}</span>
            <span className={stats.chars > 2200 || stats.hashtags > 30 ? 'font-bold text-red-300' : 'text-slate-400'}>{stats.chars}/2.200 · {stats.hashtags}/30 hashtags</span>
          </span>
          <textarea
            value={caption}
            rows={5}
            maxLength={2200}
            disabled={!editable || busy}
            onChange={event => setCaption(event.target.value)}
            placeholder="A legenda aparece aqui. Você pode escrever ou editar à mão."
            className={`${INPUT} mt-1 resize-y font-normal leading-relaxed`}
          />
        </label>

        {video.transcript && (
          <div className="text-xs">
            <button type="button" onClick={() => setShowTranscript(open => !open)} className="font-semibold text-blue-300 hover:underline">
              {showTranscript ? 'Esconder o que a IA ouviu' : 'Ver o que a IA ouviu no áudio'}
            </button>
            {showTranscript && <p className="mt-1 max-h-32 overflow-y-auto rounded border border-slate-700 bg-slate-950 p-2 text-slate-300">{video.transcript}</p>}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {editable && captionDirty && (
            <>
              <button type="button" disabled={busy || stats.chars > 2200 || stats.hashtags > 30} onClick={() => void onSave(video, { caption })} className={BUTTON} style={GREEN}><Check className="h-3.5 w-3.5" />Salvar legenda</button>
              <button type="button" disabled={busy} onClick={() => setCaption(video.caption)} className={BUTTON} style={GREY}><Undo2 className="h-3.5 w-3.5" />Desfazer</button>
            </>
          )}
          {editable && !captionDirty && (
            <button type="button" disabled={busy || !canCaption} onClick={() => onCaption(video)} title={canCaption ? 'Conta 1 pergunta no limite do mês' : 'Limite do mês acabou'} className={BUTTON} style={BLUE}>
              <Sparkles className="h-3.5 w-3.5" />{video.caption ? 'Gerar legenda de novo' : 'Gerar legenda com a IA'}
            </button>
          )}
          {(video.status === 'RASCUNHO' || video.status === 'PAUSADO') && !captionDirty && (
            <button type="button" disabled={busy || !video.caption.trim() || !video.scheduledAt} onClick={() => onAction(video, 'APROVAR')} title={!video.scheduledAt ? 'Escolha a data antes' : ''} className={BUTTON} style={GREEN}><Check className="h-3.5 w-3.5" />Aprovar</button>
          )}
          {video.status === 'APROVADO' && (
            <>
              <button type="button" disabled={busy} onClick={() => onAction(video, 'PAUSAR')} className={BUTTON} style={GREY}><Pause className="h-3.5 w-3.5" />Pausar</button>
              <button type="button" disabled={busy} onClick={() => onAction(video, 'DESAPROVAR')} className={BUTTON} style={GREY}><Undo2 className="h-3.5 w-3.5" />Desaprovar</button>
            </>
          )}
          {video.status === 'PAUSADO' && (
            <button type="button" disabled={busy} onClick={() => onAction(video, 'RETOMAR')} className={BUTTON} style={GREEN}><Play className="h-3.5 w-3.5" />Retomar</button>
          )}
          {video.status === 'ERRO' && !captionDirty && (
            <button type="button" disabled={busy} onClick={() => onAction(video, 'TENTAR_DE_NOVO')} title="Publica na próxima rodada (até 5 minutos) se o horário já passou" className={BUTTON} style={GREEN}><RotateCcw className="h-3.5 w-3.5" />Tentar de novo</button>
          )}
          {video.permalink && (
            <a href={video.permalink} target="_blank" rel="noreferrer" className={BUTTON} style={BLUE}><ExternalLink className="h-3.5 w-3.5" />Ver no Instagram</a>
          )}
          {!video.videoDeleted && (
            <button type="button" disabled={busy} onClick={() => onWatch(video)} className={BUTTON} style={GREY}><Eye className="h-3.5 w-3.5" />Assistir</button>
          )}
          {editable && (
            <button type="button" disabled={busy} onClick={() => onAction(video, 'CANCELAR')} className={BUTTON} style={GREY}><X className="h-3.5 w-3.5" />Cancelar</button>
          )}
          {video.status !== 'PUBLICANDO' && (
            <button type="button" disabled={busy} onClick={() => onDelete(video)} className={BUTTON} style={RED}><Trash2 className="h-3.5 w-3.5" />Excluir</button>
          )}
        </div>
      </div>
    </article>
  );
}

export default function VideoMakerPanel({ currentUser, stores, unitId, onUnitChange, onBack, onBusyChange, notice, onNoticeClose, onUsage }: Props) {
  const [state, setState] = useState<VideoMakerState | null | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [slotTimes, setSlotTimes] = useState<string[]>(['12:00', '18:00']);
  const [niche, setNiche] = useState('');
  const [settingsSaved, setSettingsSaved] = useState('');
  const [rights, setRights] = useState(false);
  const [listen, setListen] = useState(true);
  const [autoCaption, setAutoCaption] = useState(true);
  const [startDate, setStartDate] = useState(todayKey);
  const [driveOpen, setDriveOpen] = useState(false);
  const [driveLink, setDriveLink] = useState('');
  const [driveFiles, setDriveFiles] = useState<DriveVideo[] | null>(null);
  const [driveSelected, setDriveSelected] = useState<Set<string>>(new Set());
  const [driveLoading, setDriveLoading] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [showDone, setShowDone] = useState(false);
  const queueRef = useRef<QueueItem[]>([]);
  const processingRef = useRef(false);
  const activeRef = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const unitRef = useRef(unitId);
  unitRef.current = unitId;

  const reload = useCallback(async () => {
    try {
      const next = await getVideoMakerState(unitRef.current);
      setState(next);
      setLoadError('');
      if (next) {
        onUsage(next.used, next.limit);
        activeRef.current = next.videos.filter(video => video.status !== 'PUBLICADO' && video.status !== 'CANCELADO').length;
        const urls = await signedVideoUrls(next.videos.map(video => video.framePaths[0]).filter(Boolean));
        setThumbs(urls);
      }
    } catch (loadFailure) {
      setLoadError(errorText(loadFailure, 'Não foi possível abrir o VideoMaker.'));
    }
  }, [onUsage]);

  useEffect(() => {
    setState(undefined);
    void reload();
  }, [unitId, reload]);

  // Atualiza sozinho a cada 1 minuto (situação das publicações).
  useEffect(() => {
    const timer = window.setInterval(() => { if (!processingRef.current) void reload(); }, 60000);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (!state) return;
    setSlotTimes(state.settings.slotTimes.length ? state.settings.slotTimes : ['12:00', '18:00']);
    setNiche(state.settings.niche);
  }, [state?.settings.slotTimes.join(','), state?.settings.niche]); // eslint-disable-line react-hooks/exhaustive-deps

  // Aviso ao fechar a aba no meio de um envio.
  const processing = queue.some(item => !item.done);
  useEffect(() => {
    onBusyChange(processing);
    if (!processing) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [processing, onBusyChange]);

  const updateItem = (key: string, patch: Partial<QueueItem>) => {
    queueRef.current = queueRef.current.map(item => (item.key === key ? { ...item, ...patch } : item));
    setQueue(queueRef.current);
  };

  const replaceVideo = (video: AgencyVideo) => setState(current => (current
    ? { ...current, videos: current.videos.some(item => item.id === video.id) ? current.videos.map(item => (item.id === video.id ? video : item)) : [...current.videos, video] }
    : current));

  const processItem = async (item: QueueItem, targetUnit: string) => {
    const id = crypto.randomUUID();
    const uploaded: string[] = [];
    try {
      if (!currentUser.tenantId) throw new Error('Empresa não identificada. Entre de novo.');
      if (activeRef.current >= (state?.maxActive ?? 40)) throw new Error('A fila já tem 40 vídeos. Espere alguns serem publicados ou exclua algum.');
      let file = item.file;
      if (!file && item.drive) {
        updateItem(item.key, { step: 'Baixando do Drive', progress: 0 });
        file = await downloadDriveVideo(item.drive, fraction => updateItem(item.key, { progress: fraction }));
      }
      if (!file) throw new Error('Arquivo não encontrado.');
      const mime = mimeOf(file);
      if (!mime) throw new Error('Formato aceito: MP4 ou MOV.');
      if (file.size > MAX_VIDEO_BYTES) throw new Error(`O vídeo pode ter até ${MAX_VIDEO_MB} MB.`);

      updateItem(item.key, { step: 'Lendo o vídeo', progress: null });
      const info = await probeVideo(file);
      if (info.duration < 3 || info.duration > 900) throw new Error('O vídeo precisa ter de 3 segundos a 15 minutos.');
      const warnings: string[] = [];
      let frames: Blob[] = [];
      if (info.canDecode) {
        updateItem(item.key, { step: 'Tirando fotos do vídeo' });
        frames = await extractFrames(file, info.duration, 8);
      } else {
        warnings.push('Este navegador não mostra a imagem deste vídeo (formato HEVC): a IA usa só o áudio e a sua frase.');
      }

      let transcript = '';
      if (listen && info.duration <= 600) {
        updateItem(item.key, { step: 'Ouvindo o áudio' });
        try {
          const audio = await extractAudio(file);
          if (audio) {
            transcript = await transcribe(audio, progress => updateItem(item.key, progress.phase === 'download'
              ? { step: 'Baixando o "ouvido" da IA (só na 1ª vez)', progress: progress.fraction }
              : { step: 'Ouvindo o áudio', progress: null }));
          }
        } catch {
          warnings.push('Não foi possível ouvir o áudio deste vídeo.');
        }
      }

      const base = `${currentUser.tenantId}/${targetUnit}/${id}/`;
      updateItem(item.key, { step: 'Enviando as fotos', progress: null });
      const framePaths: string[] = [];
      for (let index = 0; index < frames.length; index += 1) {
        const path = `${base}f${index + 1}.jpg`;
        await uploadSmallFile(path, frames[index], 'image/jpeg');
        uploaded.push(path);
        framePaths.push(path);
      }
      const videoPath = `${base}video.${mime === 'video/quicktime' ? 'mov' : 'mp4'}`;
      updateItem(item.key, { step: 'Enviando o vídeo', progress: 0 });
      await uploadVideoFile(videoPath, file, mime, fraction => updateItem(item.key, { progress: fraction }));
      uploaded.push(videoPath);

      updateItem(item.key, { step: 'Registrando', progress: null });
      const video = await registerAgencyVideo(targetUnit, {
        id,
        fileName: file.name,
        storagePath: videoPath,
        framePaths,
        mimeType: mime,
        sizeBytes: file.size,
        durationSeconds: Math.round(info.duration * 100) / 100,
        width: info.width,
        height: info.height,
        source: item.drive ? 'DRIVE' : 'ARQUIVO',
        driveFileId: item.drive?.id ?? null,
        note: '',
        transcript,
        rightsConfirmed: true,
      });
      uploaded.length = 0;
      activeRef.current += 1;
      if (targetUnit === unitRef.current) replaceVideo(video);

      if (autoCaption) {
        updateItem(item.key, { step: 'Escrevendo a legenda' });
        try {
          const result = await generateCaption(targetUnit, video.id);
          onUsage(result.used, result.limit);
          if (targetUnit === unitRef.current) replaceVideo({ ...video, caption: result.caption, captionSource: result.source as AgencyVideo['captionSource'] });
        } catch (captionError) {
          warnings.push(`Legenda não gerada: ${errorText(captionError, 'tente de novo')}`);
        }
      }
      updateItem(item.key, { step: 'Pronto', progress: null, done: true, warning: warnings.join(' ') || undefined });
    } catch (failure) {
      await removeVideoFiles(uploaded);
      updateItem(item.key, { step: 'Erro', progress: null, done: true, error: errorText(failure, 'Não foi possível processar o vídeo.') });
    }
  };

  const runQueue = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    const targetUnit = unitRef.current;
    try {
      for (;;) {
        const next = queueRef.current.find(item => !item.done && item.step === 'Na fila');
        if (!next) break;
        await processItem(next, targetUnit);
      }
    } finally {
      processingRef.current = false;
      void reload();
    }
  };

  const enqueue = (items: Array<Pick<QueueItem, 'name' | 'file' | 'drive'>>) => {
    if (items.length === 0) return;
    const added = items.map((item, index) => ({ ...item, key: `${Date.now()}-${index}-${item.name}`, step: 'Na fila', progress: null, done: false }));
    queueRef.current = [...queueRef.current.filter(item => !item.done || item.error), ...added];
    setQueue(queueRef.current);
    void runQueue();
  };

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files: File[] = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    enqueue(files.map(file => ({ name: file.name, file })));
  };

  const readDrive = async () => {
    setError('');
    setDriveLoading(true);
    try {
      const files = await listDriveFolderVideos(driveLink);
      setDriveFiles(files);
      setDriveSelected(new Set(files.filter(file => file.size <= MAX_VIDEO_BYTES).map(file => file.id)));
      if (files.length === 0) setError('Nenhum vídeo MP4 ou MOV nesta pasta.');
    } catch (driveError) {
      setDriveFiles(null);
      setError(errorText(driveError, 'Não foi possível ler a pasta.'));
    } finally {
      setDriveLoading(false);
    }
  };

  const importDrive = () => {
    const chosen = (driveFiles || []).filter(file => driveSelected.has(file.id));
    enqueue(chosen.map(file => ({ name: file.name, drive: file })));
    setDriveOpen(false);
    setDriveFiles(null);
    setDriveSelected(new Set());
  };

  const run = async (id: string, task: () => Promise<void>) => {
    setError('');
    setBusyId(id);
    try {
      await task();
    } catch (failure) {
      setError(errorText(failure, 'Não foi possível concluir.'));
      void reload();
    } finally {
      setBusyId(null);
    }
  };

  const onAction = (video: AgencyVideo, action: VideoAction) => {
    if (action === 'CANCELAR' && !window.confirm(`Cancelar a postagem de "${video.fileName}"? O arquivo é apagado em 7 dias.`)) return;
    void run(video.id, async () => replaceVideo(await setAgencyVideoStatus(video.id, action)));
  };

  const onSave = (video: AgencyVideo, changes: { note?: string; caption?: string; scheduledAt?: string | null }) =>
    run(video.id, async () => replaceVideo(await updateAgencyVideo(video.id, changes)));

  const onCaption = (video: AgencyVideo) => {
    if (video.caption && !window.confirm('Gerar outra legenda? A atual será substituída e conta 1 pergunta no limite do mês.')) return;
    void run(video.id, async () => {
      const result = await generateCaption(unitId, video.id);
      onUsage(result.used, result.limit);
      await reload();
    });
  };

  const onWatch = async (video: AgencyVideo) => {
    const urls = await signedVideoUrls([video.storagePath]);
    if (urls[video.storagePath]) window.open(urls[video.storagePath], '_blank', 'noopener');
    else setError('Não foi possível abrir o vídeo.');
  };

  const onDelete = (video: AgencyVideo) => {
    if (!window.confirm(`Excluir "${video.fileName}"? ${video.status === 'PUBLICADO' ? 'O post continua no Instagram; sai só daqui.' : 'Ele não será publicado.'}`)) return;
    void run(video.id, async () => {
      await deleteAgencyVideo(video.id);
      await reload();
    });
  };

  const pending = useMemo(() => (state?.videos || []).filter(video => EDITABLE_STATUSES.includes(video.status) || video.status === 'PUBLICANDO'), [state?.videos]);
  const finished = useMemo(() => (state?.videos || []).filter(video => video.status === 'PUBLICADO' || video.status === 'CANCELADO'), [state?.videos]);
  const editableList = pending.filter(video => EDITABLE_STATUSES.includes(video.status));

  const onMove = (video: AgencyVideo, direction: -1 | 1) => {
    const index = editableList.findIndex(item => item.id === video.id);
    const other = editableList[index + direction];
    if (!other) return;
    void run(video.id, async () => {
      await swapAgencyVideos(video.id, other.id);
      await reload();
    });
  };

  const buildCalendar = () => {
    if (editableList.length === 0) return;
    if (editableList.some(video => video.scheduledAt) && !window.confirm('Remontar o calendário? As datas dos vídeos ainda não publicados serão refeitas na ordem da lista.')) return;
    void run('calendar', async () => {
      await scheduleAgencyVideos(unitId, startDate, editableList.map(video => video.id));
      await reload();
    });
  };

  const approveAll = () => {
    const ready = editableList.filter(video => (video.status === 'RASCUNHO' || video.status === 'PAUSADO') && video.caption.trim() && video.scheduledAt);
    if (ready.length === 0) { setError('Nenhum vídeo pronto para aprovar (precisa de legenda e data).'); return; }
    if (!window.confirm(`Aprovar ${ready.length} vídeo(s)? Eles serão publicados sozinhos no dia e hora marcados.`)) return;
    void run('approve', async () => {
      const failures: string[] = [];
      for (const video of ready) {
        try {
          await setAgencyVideoStatus(video.id, 'APROVAR');
        } catch (failure) {
          failures.push(`${video.fileName}: ${errorText(failure, 'erro')}`);
        }
      }
      await reload();
      if (failures.length) setError(`Não aprovados: ${failures.join(' | ')}`);
    });
  };

  const saveSettings = () => void run('settings', async () => {
    await saveVideoMakerSettings(unitId, slotTimes, niche);
    setSettingsSaved('Salvo');
    window.setTimeout(() => setSettingsSaved(''), 2500);
    await reload();
  });

  const connect = () => {
    if (processing && !window.confirm('Ainda há vídeos sendo enviados. Sair agora interrompe o envio. Continuar?')) return;
    void run('connect', async () => { window.location.href = await startInstagramConnect(unitId); });
  };

  const disconnect = () => {
    if (!window.confirm('Desconectar o Instagram desta loja? Os vídeos agendados ficam pausados.')) return;
    void run('disconnect', async () => {
      await disconnectInstagram(unitId);
      await reload();
    });
  };

  const back = () => {
    if (processing && !window.confirm('Ainda há vídeos sendo enviados. Sair do VideoMaker interrompe o envio. Sair mesmo assim?')) return;
    onBack();
  };

  const account = state?.account ?? null;
  const accountExpired = account?.status === 'EXPIRADA';
  const counts = {
    scheduled: pending.filter(video => video.status === 'APROVADO').length,
    toApprove: pending.filter(video => video.status === 'RASCUNHO').length,
    errors: pending.filter(video => video.status === 'ERRO').length,
  };
  const lastScheduled = pending.filter(video => video.status === 'APROVADO' && video.scheduledAt).map(video => video.scheduledAt!).sort().pop() ?? null;
  const canAdd = rights && !processing && state != null && activeRef.current < state.maxActive;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" style={{ fontFamily: 'var(--font-sans)' }}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={back} className={BUTTON} style={BLUE}><ArrowLeft className="h-4 w-4" />Voltar ao escritório</button>
        <h3 className="flex items-center gap-2 text-lg font-bold text-white" style={{ fontFamily: "'Pixelify Sans', ui-monospace, monospace" }}>
          <Film className="h-5 w-5 text-pink-400" />VideoMaker <span className="text-sm font-normal text-slate-400">(sala de Marketing)</span>
        </h3>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          Loja
          <select value={unitId} disabled={stores.length <= 1 || processing} onChange={event => onUnitChange(event.target.value)} className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-slate-100">
            {stores.map(store => <option key={store.unitId} value={store.unitId}>{store.tradeName || store.unitId}</option>)}
          </select>
        </label>
        <p className="text-xs text-slate-400">Cada legenda feita pela IA conta 1 pergunta no limite do mês. Nada é postado sem a sua aprovação.</p>
      </div>

      {notice && (
        <div className={`flex items-start justify-between gap-2 rounded border-2 px-3 py-2 text-sm ${notice.ok ? 'border-green-600 bg-green-950/60 text-green-100' : 'border-red-700 bg-red-950/60 text-red-100'}`}>
          <span>{notice.text}</span>
          <button type="button" onClick={onNoticeClose} aria-label="Fechar aviso" className="text-slate-300 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
      )}

      {state === undefined && !loadError && <p className="flex items-center gap-2 text-sm text-slate-300"><Loader2 className="h-4 w-4 animate-spin" />Abrindo o VideoMaker...</p>}
      {loadError && <p className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200">{loadError}</p>}
      {state === null && <p className="rounded border border-amber-700 bg-amber-950/50 px-3 py-2 text-sm text-amber-100">O VideoMaker ainda não foi ativado no banco do Kanguru (falta aplicar a atualização 20261212).</p>}

      {state && (
        <>
          <div className="grid gap-3 lg:grid-cols-3">
            <section className="space-y-2 rounded-xl border-2 p-3" style={PANEL}>
              <h4 className="flex items-center gap-2 text-sm font-bold text-blue-100"><AtSign className="h-4 w-4" />Instagram da loja</h4>
              {!account && (
                <>
                  <p className="text-xs text-slate-300">Conecte a conta Profissional do Instagram desta loja. A ligação fica guardada só no servidor e é renovada sozinha.</p>
                  {state.isOwner
                    ? <button type="button" disabled={busyId === 'connect'} onClick={connect} className={BUTTON} style={GREEN}>{busyId === 'connect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AtSign className="h-3.5 w-3.5" />}Conectar Instagram</button>
                    : <p className="text-xs font-semibold text-amber-200">Peça ao dono da empresa para conectar o Instagram.</p>}
                </>
              )}
              {account && (
                <>
                  <p className="text-sm text-slate-100">
                    <span className="font-bold">@{account.username || 'conta conectada'}</span>{' '}
                    <span className={accountExpired ? 'font-bold text-red-300' : 'text-green-300'}>{accountExpired ? '· ligação expirada' : '· conectado'}</span>
                  </p>
                  <p className="text-xs text-slate-400">
                    {accountExpired
                      ? 'Os vídeos não serão publicados até conectar de novo.'
                      : `Conectado por ${account.connectedByName || 'dono'}. Renovação automática (válida até ${new Date(account.expiresAt).toLocaleDateString('pt-BR')}).`}
                  </p>
                  {account.lastError && !accountExpired && <p className="text-xs text-amber-200">{account.lastError}</p>}
                  {state.isOwner && (
                    <div className="flex flex-wrap gap-1.5">
                      {accountExpired && <button type="button" disabled={busyId === 'connect'} onClick={connect} className={BUTTON} style={GREEN}><AtSign className="h-3.5 w-3.5" />Conectar de novo</button>}
                      <button type="button" disabled={busyId === 'disconnect'} onClick={disconnect} className={BUTTON} style={GREY}>Desconectar</button>
                    </div>
                  )}
                </>
              )}
            </section>

            <section className="space-y-2 rounded-xl border-2 p-3" style={PANEL}>
              <h4 className="flex items-center gap-2 text-sm font-bold text-blue-100"><CalendarDays className="h-4 w-4" />Horários e loja</h4>
              <div className="flex flex-wrap items-center gap-1.5">
                {slotTimes.map((time, index) => (
                  <span key={index} className="flex items-center gap-1">
                    <input type="time" value={time} onChange={event => setSlotTimes(current => current.map((item, i) => (i === index ? event.target.value : item)))} className="rounded border border-slate-600 bg-slate-950 px-1.5 py-1 text-sm text-slate-100" aria-label={`Horário ${index + 1}`} />
                    {slotTimes.length > 1 && <button type="button" onClick={() => setSlotTimes(current => current.filter((_, i) => i !== index))} aria-label="Remover horário" className="text-slate-400 hover:text-red-300"><X className="h-3.5 w-3.5" /></button>}
                  </span>
                ))}
                {slotTimes.length < 4 && <button type="button" onClick={() => setSlotTimes(current => [...current, '15:00'])} className={BUTTON} style={GREY}><Plus className="h-3.5 w-3.5" />Horário</button>}
              </div>
              <p className="text-[11px] text-slate-400">1 vídeo por dia, alternando estes horários.</p>
              <label className="block text-xs text-slate-300">
                Sobre a loja e o público (a IA usa nas legendas)
                <textarea value={niche} onChange={event => setNiche(event.target.value)} rows={3} maxLength={1500} placeholder="Ex.: loja de games no shopping de Campo Grande (RJ), público jovem, vende consoles, acessórios e cartas Pokémon." className={`${INPUT} mt-1 resize-y`} />
              </label>
              <button type="button" disabled={busyId === 'settings'} onClick={saveSettings} className={BUTTON} style={BLUE}>{busyId === 'settings' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Salvar</button>
              {settingsSaved && <span className="ml-2 text-xs text-green-300">{settingsSaved}</span>}
            </section>

            <section className="space-y-2 rounded-xl border-2 p-3" style={PANEL}>
              <h4 className="flex items-center gap-2 text-sm font-bold text-blue-100"><Upload className="h-4 w-4" />Adicionar vídeos <span className="ml-auto font-mono text-xs text-slate-300">{activeRef.current}/{state.maxActive} na fila</span></h4>
              <p className="text-[11px] text-slate-400">MP4 ou MOV, de 3 s a 15 min, até {MAX_VIDEO_MB} MB, de preferência em pé (9:16).</p>
              <label className="flex items-start gap-2 text-xs text-slate-200">
                <input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)} className="mt-0.5" />
                Confirmo que a loja tem direito de usar estes vídeos e as músicas deles (música com direitos autorais pode ser silenciada pelo Instagram).
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={listen} onChange={event => setListen(event.target.checked)} />Ouvir o áudio (transcrever no computador)</label>
              <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={autoCaption} disabled={!state.captionOk} onChange={event => setAutoCaption(event.target.checked)} />Gerar a legenda pela IA ao subir</label>
              <div className="flex flex-wrap gap-1.5">
                <input ref={fileInput} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" multiple className="hidden" onChange={onFiles} />
                <button type="button" disabled={!canAdd} onClick={() => fileInput.current?.click()} className={BUTTON} style={GREEN}><Upload className="h-3.5 w-3.5" />Subir vídeos</button>
                <button type="button" disabled={!canAdd} onClick={() => setDriveOpen(open => !open)} title={driveImportAvailable() ? '' : 'Ainda não configurado'} className={BUTTON} style={BLUE}><FolderOpen className="h-3.5 w-3.5" />Importar de uma pasta do Drive</button>
              </div>
              {!rights && <p className="text-[11px] text-amber-200">Marque a confirmação para liberar o envio.</p>}
            </section>
          </div>

          {driveOpen && (
            <section className="space-y-2 rounded-xl border-2 p-3" style={PANEL}>
              <h4 className="text-sm font-bold text-blue-100">Importar de uma pasta do Google Drive</h4>
              <p className="text-xs text-slate-300">No Drive, clique na pasta › Compartilhar › Acesso geral: <b>Qualquer pessoa com o link</b>. Cole o link aqui. Os vídeos são baixados por este computador: deixe a página aberta até terminar.</p>
              {!driveImportAvailable() && <p className="text-xs font-semibold text-amber-200">A importação do Drive ainda não foi configurada pela Kanguru.</p>}
              <div className="flex flex-wrap gap-2">
                <input value={driveLink} onChange={event => setDriveLink(event.target.value)} placeholder="https://drive.google.com/drive/folders/..." className={`${INPUT} min-w-[240px] flex-1`} />
                <button type="button" disabled={driveLoading || !driveLink.trim() || !driveImportAvailable()} onClick={() => void readDrive()} className={BUTTON} style={BLUE}>{driveLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}Ler pasta</button>
              </div>
              {driveFiles && driveFiles.length > 0 && (
                <>
                  <ul className="max-h-60 space-y-1 overflow-y-auto">
                    {driveFiles.map(file => {
                      const tooBig = file.size > MAX_VIDEO_BYTES;
                      return (
                        <li key={file.id}>
                          <label className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${tooBig ? 'text-slate-500' : 'text-slate-200 hover:bg-white/5'}`}>
                            <input
                              type="checkbox"
                              disabled={tooBig}
                              checked={driveSelected.has(file.id)}
                              onChange={event => setDriveSelected(current => { const next = new Set(current); if (event.target.checked) next.add(file.id); else next.delete(file.id); return next; })}
                            />
                            <span className="min-w-0 flex-1 truncate">{file.name}</span>
                            <span>{formatSize(file.size)}{tooBig ? ` (passa de ${MAX_VIDEO_MB} MB)` : ''}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  <button type="button" disabled={driveSelected.size === 0 || activeRef.current + driveSelected.size > state.maxActive} onClick={importDrive} className={BUTTON} style={GREEN}>
                    <Upload className="h-3.5 w-3.5" />Importar {driveSelected.size} vídeo(s)
                  </button>
                  {activeRef.current + driveSelected.size > state.maxActive && <span className="ml-2 text-xs text-amber-200">Passa do limite de {state.maxActive} vídeos na fila.</span>}
                </>
              )}
            </section>
          )}

          {queue.length > 0 && (
            <section className="space-y-2 rounded-xl border-2 p-3" style={PANEL}>
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-bold text-blue-100">Envio {processing ? '(não feche esta página até terminar)' : 'concluído'}</h4>
                {!processing && <button type="button" onClick={() => { queueRef.current = []; setQueue([]); }} className={BUTTON} style={GREY}>Limpar lista</button>}
              </div>
              <ul className="space-y-1.5">
                {queue.map(item => (
                  <li key={item.key} className="rounded border border-slate-700 px-2 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      {!item.done ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-300" /> : item.error ? <X className="h-3.5 w-3.5 shrink-0 text-red-300" /> : <Check className="h-3.5 w-3.5 shrink-0 text-green-300" />}
                      <span className="min-w-0 flex-1 truncate text-slate-100">{item.name}</span>
                      <span className={item.error ? 'text-red-300' : 'text-slate-300'}>{item.step}{item.progress != null ? ` ${Math.round(item.progress * 100)}%` : ''}</span>
                    </div>
                    {item.progress != null && !item.done && (
                      <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-800"><div className="h-full bg-blue-500" style={{ width: `${Math.round(item.progress * 100)}%` }} /></div>
                    )}
                    {item.error && <p className="mt-1 text-red-200">{item.error}</p>}
                    {item.warning && <p className="mt-1 text-amber-200">{item.warning}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-3 rounded-xl border-2 p-3" style={PANEL}>
            <div className="flex flex-wrap items-end gap-3">
              <h4 className="text-sm font-bold text-blue-100">Calendário</h4>
              <span className="text-xs text-slate-300">
                {counts.scheduled} agendado(s) · {counts.toApprove} falta(m) aprovar{counts.errors ? ` · ${counts.errors} com erro` : ''}
                {lastScheduled ? ` · fila vai até ${new Date(lastScheduled).toLocaleDateString('pt-BR')}` : ''}
              </span>
              <span className="ml-auto flex flex-wrap items-end gap-2">
                <label className="text-xs text-slate-300">
                  Começar em
                  <input type="date" value={startDate} min={todayKey()} onChange={event => setStartDate(event.target.value)} className="ml-1 rounded border border-slate-600 bg-slate-950 px-1.5 py-1 text-sm text-slate-100" />
                </label>
                <button type="button" disabled={busyId !== null || editableList.length === 0} onClick={buildCalendar} className={BUTTON} style={BLUE}>{busyId === 'calendar' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarDays className="h-3.5 w-3.5" />}Montar calendário</button>
                <button type="button" disabled={busyId !== null || counts.toApprove + pending.filter(video => video.status === 'PAUSADO').length === 0} onClick={approveAll} className={BUTTON} style={GREEN}>{busyId === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Aprovar todos prontos</button>
              </span>
            </div>
            {!account && pending.length > 0 && <p className="text-xs font-semibold text-amber-200">Sem o Instagram conectado, os vídeos aprovados vão dar erro na hora de postar.</p>}
            {error && <p className="rounded border border-red-800 bg-red-950/60 px-2 py-1.5 text-xs text-red-200">{error}</p>}
            {pending.length === 0 && <p className="text-sm text-slate-400">Nenhum vídeo na fila. Suba os vídeos acima: a IA escreve as legendas e você aprova.</p>}
            <div className="space-y-2">
              {pending.map(video => {
                const index = editableList.findIndex(item => item.id === video.id);
                return (
                  <VideoCard
                    key={video.id}
                    video={video}
                    thumb={thumbs[video.framePaths[0]]}
                    busy={busyId === video.id}
                    canCaption={state.captionOk}
                    canMoveUp={index > 0}
                    canMoveDown={index >= 0 && index < editableList.length - 1}
                    onAction={onAction}
                    onSave={onSave}
                    onCaption={onCaption}
                    onMove={onMove}
                    onWatch={video => void onWatch(video)}
                    onDelete={onDelete}
                  />
                );
              })}
            </div>
          </section>

          {finished.length > 0 && (
            <section className="space-y-2 rounded-xl border-2 p-3" style={PANEL}>
              <button type="button" onClick={() => setShowDone(open => !open)} className="flex w-full items-center justify-between text-sm font-bold text-blue-100">
                <span>Publicados e cancelados (últimos 60 dias): {finished.length}</span>
                <span className="text-xs text-slate-400">{showDone ? 'esconder' : 'mostrar'}</span>
              </button>
              {showDone && (
                <div className="space-y-2">
                  {finished.map(video => (
                    <VideoCard
                      key={video.id}
                      video={video}
                      thumb={thumbs[video.framePaths[0]]}
                      busy={busyId === video.id}
                      canCaption={false}
                      canMoveUp={false}
                      canMoveDown={false}
                      onAction={onAction}
                      onSave={onSave}
                      onCaption={onCaption}
                      onMove={onMove}
                      onWatch={item => void onWatch(item)}
                      onDelete={onDelete}
                    />
                  ))}
                  <p className="text-[11px] text-slate-500">O arquivo do vídeo é apagado do Kanguru 7 dias depois de publicado ou cancelado (fica a miniatura e o link do post).</p>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
