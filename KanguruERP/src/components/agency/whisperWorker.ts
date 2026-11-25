// "Ouvido" do VideoMaker: transcreve o áudio do vídeo com o Whisper rodando NO NAVEGADOR
// (transformers.js). O áudio não sai do computador; só o modelo é baixado (uma vez, fica no cache).
//
// Testado em 2026-11-25 com fala em português (15 s): com placa de vídeo (WebGPU) o modelo
// "small" acerta quase tudo e é rápido; sem WebGPU, o "small" leva ~4x o tempo do áudio, então
// usamos o "base" (~1x o tempo do áudio, erra um pouco mais).

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

type AsrPipeline = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text?: string } | Array<{ text?: string }>>;

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
}

const scope = self as unknown as WorkerScope;
let asr: Promise<AsrPipeline> | null = null;
let currentId = 0;
const loaded = new Map<string, { loaded: number; total: number }>();

const progress = (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
  if (info.status !== 'progress' || !info.file || !info.total) return;
  loaded.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
  const sum = Array.from(loaded.values()).reduce((acc, item) => ({ loaded: acc.loaded + item.loaded, total: acc.total + item.total }), { loaded: 0, total: 0 });
  scope.postMessage({ id: currentId, type: 'download', fraction: sum.total ? sum.loaded / sum.total : 0 });
};

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    return Boolean(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

function load(): Promise<AsrPipeline> {
  if (!asr) {
    asr = (async () => {
      const lib = await import(/* @vite-ignore */ TRANSFORMERS_URL);
      lib.env.allowLocalModels = false;
      if (await hasWebGpu()) {
        try {
          return await lib.pipeline('automatic-speech-recognition', 'onnx-community/whisper-small', {
            dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
            device: 'webgpu',
            progress_callback: progress,
          }) as AsrPipeline;
        } catch {
          loaded.clear();
        }
      }
      return lib.pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: progress,
      }) as Promise<AsrPipeline>;
    })();
    asr.catch(() => { asr = null; });
  }
  return asr;
}

scope.onmessage = async (event: MessageEvent) => {
  const { id, audio } = event.data as { id: number; audio: Float32Array };
  currentId = id;
  try {
    const pipe = await load();
    scope.postMessage({ id, type: 'listening' });
    const output = await pipe(audio, { language: 'portuguese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    const text = Array.isArray(output) ? output.map(item => item.text ?? '').join(' ') : output.text ?? '';
    scope.postMessage({ id, type: 'done', text });
  } catch (error) {
    scope.postMessage({ id, type: 'error', message: String((error as Error)?.message || error) });
  }
};
