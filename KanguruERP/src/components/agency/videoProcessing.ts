// VideoMaker: "assistir" o vídeo no próprio navegador do franqueado.
// - fotos espalhadas pelo vídeo (a IA lê as fotos, porque não assiste vídeo);
// - áudio convertido para 16 kHz e transcrito pelo Whisper (whisperWorker.ts).

export interface VideoInfo {
  duration: number;
  width: number | null;
  height: number | null;
  // false quando o navegador não consegue mostrar a imagem (ex.: HEVC sem o codec no Windows).
  canDecode: boolean;
}

const withTimeout = <T,>(promise: Promise<T>, ms: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => { window.clearTimeout(timer); resolve(value); }, error => { window.clearTimeout(timer); reject(error); });
  });

// Duração lida direto do arquivo MP4/MOV (caixa "mvhd"), para quando o navegador não abre o vídeo.
async function containerDuration(blob: Blob): Promise<number | null> {
  const readBox = async (start: number) => {
    const head = new DataView(await blob.slice(start, start + 16).arrayBuffer());
    if (head.byteLength < 8) return null;
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let header = 8;
    if (size === 1 && head.byteLength >= 16) { size = Number(head.getBigUint64(8)); header = 16; }
    else if (size === 0) size = blob.size - start;
    return { size, type, header };
  };
  try {
    let offset = 0;
    while (offset < blob.size) {
      const box = await readBox(offset);
      if (!box || box.size < 8) return null;
      if (box.type === 'moov') {
        let inner = offset + box.header;
        const end = offset + box.size;
        while (inner < end) {
          const child = await readBox(inner);
          if (!child || child.size < 8) return null;
          if (child.type === 'mvhd') {
            const data = new DataView(await blob.slice(inner + child.header, inner + child.header + 32).arrayBuffer());
            const version = data.getUint8(0);
            const timescale = version === 1 ? data.getUint32(20) : data.getUint32(12);
            const duration = version === 1 ? Number(data.getBigUint64(24)) : data.getUint32(16);
            return timescale ? duration / timescale : null;
          }
          inner += child.size;
        }
        return null;
      }
      offset += box.size;
    }
  } catch {
    return null;
  }
  return null;
}

function openVideo(blob: Blob): { video: HTMLVideoElement; done: () => void } {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  return { video, done: () => { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); } };
}

export async function probeVideo(blob: Blob): Promise<VideoInfo> {
  const { video, done } = openVideo(blob);
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('decode'));
    }), 20000, 'decode');
    const duration = Number.isFinite(video.duration) ? video.duration : (await containerDuration(blob)) ?? 0;
    return {
      duration,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      canDecode: video.videoWidth > 0,
    };
  } catch {
    const duration = await containerDuration(blob);
    if (!duration) throw new Error('Não foi possível ler este vídeo. Use MP4 ou MOV.');
    return { duration, width: null, height: null, canDecode: false };
  } finally {
    done();
  }
}

// Tira `count` fotos espalhadas pelo vídeo (JPEG, lado maior até 640 px).
export async function extractFrames(blob: Blob, duration: number, count = 8): Promise<Blob[]> {
  const { video, done } = openVideo(blob);
  const frames: Blob[] = [];
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('decode'));
    }), 20000, 'decode');
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return [];
    for (let index = 0; index < count; index += 1) {
      const time = Math.min(Math.max(0.1, (duration * (index + 0.5)) / count), Math.max(0.1, duration - 0.1));
      await withTimeout(new Promise<void>(resolve => {
        video.onseeked = () => resolve();
        video.currentTime = time;
      }), 8000, 'seek').catch(() => undefined);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.75));
      if (frame) frames.push(frame);
    }
    return frames;
  } catch {
    return frames;
  } finally {
    done();
  }
}

// Áudio mono em 16 kHz (formato do Whisper). null = vídeo sem áudio ou só silêncio.
export async function extractAudio(blob: Blob, maxSeconds = 600): Promise<Float32Array | null> {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return null;
  } finally {
    void context.close();
  }
  const seconds = Math.min(decoded.duration, maxSeconds);
  if (seconds < 0.5) return null;
  const offline = new OfflineAudioContext(1, Math.ceil(seconds * 16000), 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const audio = (await offline.startRendering()).getChannelData(0);
  let sum = 0;
  for (let index = 0; index < audio.length; index += 16) sum += audio[index] * audio[index];
  const rms = Math.sqrt(sum / Math.max(1, audio.length / 16));
  // cópia própria: pode ser transferida para o worker sem mexer no buffer do navegador
  return rms < 0.003 ? null : new Float32Array(audio);
}

// Frases que o Whisper costuma "inventar" em música ou silêncio.
const HALLUCINATIONS = [
  /legendas? pela comunidade amara\.org/gi,
  /legendado por .{0,40}/gi,
  /obrigad[oa] por assistir[.!]?/gi,
  /inscreva-se no canal[.!]?/gi,
  /\bsubt[íi]tulos realizados por .{0,40}/gi,
];

export function cleanTranscript(text: string): string {
  let result = text;
  HALLUCINATIONS.forEach(pattern => { result = result.replace(pattern, ' '); });
  return result.replace(/\s+/g, ' ').trim();
}

// ---------------- Whisper (um worker para a página toda) ----------------
type WorkerMessage =
  | { id: number; type: 'download'; fraction: number }
  | { id: number; type: 'listening' }
  | { id: number; type: 'done'; text: string }
  | { id: number; type: 'error'; message: string };

let worker: Worker | null = null;
let nextId = 1;

export type TranscribeProgress = { phase: 'download'; fraction: number } | { phase: 'listening' };

export function transcribe(audio: Float32Array, onProgress?: (progress: TranscribeProgress) => void): Promise<string> {
  if (!worker) worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
  const current = worker;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === 'download') onProgress?.({ phase: 'download', fraction: message.fraction });
      else if (message.type === 'listening') onProgress?.({ phase: 'listening' });
      else {
        current.removeEventListener('message', listener);
        if (message.type === 'done') resolve(cleanTranscript(message.text));
        else reject(new Error(message.message));
      }
    };
    current.addEventListener('message', listener);
    current.postMessage({ id, audio }, [audio.buffer]);
  });
}
