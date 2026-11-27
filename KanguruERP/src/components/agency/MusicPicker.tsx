import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Music, Pause, Play, Search, Trash2, X } from 'lucide-react';
import { searchMusic, type AgencyVideo, type MusicTrack, type VideoMusic } from '../../db/videoMaker';

// Janela "Música" do VideoMaker: busca na biblioteca do Instagram (vazio = em alta), ouve a prévia,
// escolhe, regula os volumes e pode tirar o som original do vídeo.

interface Props {
  unitId: string;
  video: AgencyVideo;
  // Texto do andamento enquanto salva (cópia sem som, envio...); null = parado.
  saving: string | null;
  error: string;
  onSave: (music: VideoMusic | null) => void;
  onClose: () => void;
}

const BUTTON = 'inline-flex items-center justify-center gap-1.5 rounded border-2 px-2.5 py-1.5 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-50';
const BLUE = { background: '#0c1a33', borderColor: '#60a5fa', color: '#bfdbfe' };
const GREEN = { background: '#0b2418', borderColor: '#4ade80', color: '#bbf7d0' };
const RED = { background: '#2a0f14', borderColor: '#f87171', color: '#fecaca' };
const GREY = { background: '#111827', borderColor: '#475569', color: '#cbd5e1' };

export const formatMusicDuration = (ms: number | null) => {
  if (!ms) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export default function MusicPicker({ unitId, video, saving, error, onSave, onClose }: Props) {
  const current = video.music;
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [chosen, setChosen] = useState<MusicTrack | null>(current
    ? { audioId: current.audioId, title: current.title, artist: current.artist, coverUrl: current.coverUrl, durationMs: current.durationMs, previewUrl: null }
    : null);
  // Padrão: música de fundo um pouco mais baixa que a fala do vídeo.
  const [musicVolume, setMusicVolume] = useState(current?.musicVolume ?? 60);
  const [videoVolume, setVideoVolume] = useState(current?.videoVolume ?? 100);
  const [muteOriginal, setMuteOriginal] = useState(current?.muteOriginal ?? false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const busy = saving !== null;

  const run = async (text: string) => {
    setLoading(true);
    setSearchError('');
    try {
      setTracks(await searchMusic(unitId, text));
      setSearched(text);
    } catch (failure) {
      setTracks(null);
      setSearchError((failure as Error)?.message || 'Não foi possível buscar músicas agora.');
    } finally {
      setLoading(false);
    }
  };

  // Abre mostrando as músicas em alta.
  useEffect(() => { void run(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const togglePreview = (track: MusicTrack) => {
    if (!track.previewUrl) return;
    if (playing === track.audioId) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(track.previewUrl);
    audio.volume = 0.8;
    audio.onended = () => setPlaying(null);
    audio.onerror = () => setPlaying(null);
    audioRef.current = audio;
    void audio.play().then(() => setPlaying(track.audioId)).catch(() => setPlaying(null));
  };

  const save = () => {
    if (!chosen) return;
    audioRef.current?.pause();
    onSave({
      audioId: chosen.audioId,
      title: chosen.title,
      artist: chosen.artist,
      coverUrl: chosen.coverUrl,
      durationMs: chosen.durationMs,
      musicVolume,
      videoVolume,
      muteOriginal,
    });
  };

  const close = () => {
    if (busy) return;
    audioRef.current?.pause();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3" role="dialog" aria-modal="true" aria-label="Música do vídeo">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col gap-3 overflow-hidden rounded-xl border-2 p-4" style={{ background: '#0f1a2c', borderColor: '#5b7fa8', boxShadow: '4px 4px 0 #070b14', fontFamily: 'var(--font-sans)' }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="flex items-center gap-2 text-base font-bold text-white"><Music className="h-4 w-4 text-pink-400" />Música do vídeo</h4>
            <p className="truncate text-xs text-slate-400" title={video.fileName}>{video.fileName}</p>
          </div>
          <button type="button" onClick={close} disabled={busy} aria-label="Fechar" className="text-slate-300 hover:text-white disabled:opacity-40"><X className="h-5 w-5" /></button>
        </div>

        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void run(query.trim()); }}>
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            disabled={busy}
            placeholder="Nome da música ou do artista"
            className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-blue-400"
            autoFocus
          />
          <button type="submit" disabled={busy || loading} className={BUTTON} style={BLUE}>{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}Buscar</button>
        </form>

        <div className="min-h-[160px] flex-1 overflow-y-auto rounded border border-slate-700 bg-slate-950/60">
          <p className="sticky top-0 border-b border-slate-800 bg-slate-950 px-2 py-1 text-[11px] font-semibold text-slate-400">
            {searched ? `Resultado para "${searched}"` : 'Em alta no Instagram'}
          </p>
          {loading && <p className="flex items-center gap-2 p-3 text-sm text-slate-300"><Loader2 className="h-4 w-4 animate-spin" />Buscando...</p>}
          {!loading && searchError && <p className="p-3 text-sm text-red-200">{searchError}</p>}
          {!loading && !searchError && tracks && tracks.length === 0 && <p className="p-3 text-sm text-slate-400">Nenhuma música encontrada. Tente outro nome.</p>}
          {!loading && tracks && tracks.length > 0 && (
            <ul>
              {tracks.map(track => {
                const selected = chosen?.audioId === track.audioId;
                return (
                  <li key={track.audioId} className={`flex items-center gap-2 border-b border-slate-800 px-2 py-1.5 ${selected ? 'bg-blue-950/60' : 'hover:bg-white/5'}`}>
                    <button
                      type="button"
                      disabled={!track.previewUrl}
                      onClick={() => togglePreview(track)}
                      title={track.previewUrl ? 'Ouvir a prévia' : 'Sem prévia'}
                      aria-label={playing === track.audioId ? 'Parar a prévia' : 'Ouvir a prévia'}
                      className="relative h-10 w-10 shrink-0 overflow-hidden rounded border border-slate-700 bg-slate-800 disabled:opacity-60"
                    >
                      {track.coverUrl && <img src={track.coverUrl} alt="" className="h-full w-full object-cover" />}
                      <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white">
                        {playing === track.audioId ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      </span>
                    </button>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-100">{track.title || 'Sem título'}</span>
                      <span className="block truncate text-xs text-slate-400">{track.artist}{track.durationMs ? ` · ${formatMusicDuration(track.durationMs)}` : ''}</span>
                    </span>
                    <button type="button" disabled={busy} onClick={() => setChosen(track)} className={BUTTON} style={selected ? GREEN : GREY}>
                      {selected ? <><Check className="h-3.5 w-3.5" />Escolhida</> : 'Escolher'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="space-y-2 rounded border border-slate-700 p-2">
          <p className="text-xs text-slate-300">
            Escolhida: {chosen ? <b className="text-slate-100">{chosen.title}{chosen.artist ? ` · ${chosen.artist}` : ''}</b> : <span className="text-slate-500">nenhuma</span>}
          </p>
          <label className="flex items-center gap-2 text-xs text-slate-200">
            <input type="checkbox" checked={muteOriginal} disabled={busy} onChange={event => setMuteOriginal(event.target.checked)} />
            Tirar o som original do vídeo (fica só a música)
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-slate-300">
              Volume da música: <b className="font-mono text-slate-100">{musicVolume}</b>
              <input type="range" min={1} max={100} value={musicVolume} disabled={busy} onChange={event => setMusicVolume(Number(event.target.value))} className="mt-1 w-full" />
            </label>
            {!muteOriginal && (
              <label className="block text-xs text-slate-300">
                Volume do som do vídeo: <b className="font-mono text-slate-100">{videoVolume}</b>
                <input type="range" min={1} max={100} value={videoVolume} disabled={busy} onChange={event => setVideoVolume(Number(event.target.value))} className="mt-1 w-full" />
              </label>
            )}
          </div>
          <p className="text-[11px] text-slate-400">
            O Instagram escolhe o trecho da música e não mostra o resultado antes de postar. Se a música sair da biblioteca até o dia, o vídeo é postado sem som e o cartão avisa.
          </p>
        </div>

        {(saving || error) && (
          <p className={`flex items-center gap-2 text-xs ${error ? 'text-red-200' : 'text-blue-200'}`}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{error || saving}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {current && (
            <button type="button" disabled={busy} onClick={() => onSave(null)} className={`${BUTTON} mr-auto`} style={RED}><Trash2 className="h-3.5 w-3.5" />Tirar a música</button>
          )}
          <button type="button" disabled={busy} onClick={close} className={BUTTON} style={GREY}>Cancelar</button>
          <button type="button" disabled={busy || !chosen} onClick={save} className={BUTTON} style={GREEN}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Salvar música
          </button>
        </div>
      </div>
    </div>
  );
}
