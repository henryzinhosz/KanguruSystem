// VideoMaker: importar vídeos de uma pasta do Google Drive compartilhada como
// "Qualquer pessoa com o link". Usa só uma chave pública do Google (VITE_GOOGLE_DRIVE_API_KEY,
// restrita ao endereço do ERP no Google Cloud), que lê apenas arquivos públicos.
// Os vídeos são baixados pelo navegador e seguem o mesmo caminho de um arquivo do computador.

export interface DriveVideo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

const env = (import.meta.env ?? {}) as unknown as Record<string, string | undefined>;
const API_KEY = env.VITE_GOOGLE_DRIVE_API_KEY || '';

export const driveImportAvailable = () => Boolean(API_KEY);

export function parseDriveFolderId(link: string): string | null {
  const text = link.trim();
  const folder = /\/folders\/([a-zA-Z0-9_-]{10,})/.exec(text);
  if (folder) return folder[1];
  const query = /[?&]id=([a-zA-Z0-9_-]{10,})/.exec(text);
  if (query) return query[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(text) ? text : null;
}

const driveError = async (response: Response) => {
  let reason = '';
  try {
    const body = await response.json();
    reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
  } catch {
    // sem corpo
  }
  if (response.status === 404) return new Error('Pasta não encontrada. Confira o link e se a pasta está como "Qualquer pessoa com o link".');
  if (response.status === 403 && /keyInvalid|API_KEY|referer|forbidden/i.test(reason)) return new Error('A chave do Google do Kanguru não aceitou este pedido. Avise o suporte.');
  if (response.status === 403) return new Error('Sem acesso à pasta. No Drive, compartilhe a pasta como "Qualquer pessoa com o link".');
  return new Error('Não foi possível ler a pasta do Drive agora.');
};

export async function listDriveFolderVideos(link: string): Promise<DriveVideo[]> {
  if (!API_KEY) throw new Error('A importação do Drive ainda não foi configurada pela Kanguru.');
  const folderId = parseDriveFolderId(link);
  if (!folderId) throw new Error('Cole o link de uma PASTA do Google Drive (drive.google.com/drive/folders/...).');
  const videos: DriveVideo[] = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false and (mimeType = 'video/mp4' or mimeType = 'video/quicktime')`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: '100',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      key: API_KEY,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    if (!response.ok) throw await driveError(response);
    const body = await response.json();
    (body.files || []).forEach((file: Record<string, unknown>) => videos.push({
      id: String(file.id),
      name: String(file.name || 'video'),
      mimeType: String(file.mimeType || 'video/mp4'),
      size: Number(file.size || 0),
    }));
    pageToken = body.nextPageToken || '';
  } while (pageToken && videos.length < 200);
  return videos;
}

// Baixa o vídeo com progresso. Precisa estar compartilhado como público.
export async function downloadDriveVideo(video: DriveVideo, onProgress?: (fraction: number) => void): Promise<File> {
  const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true', key: API_KEY });
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(video.id)}?${params}`);
  if (!response.ok || !response.body) throw await driveError(response);
  const total = Number(response.headers.get('content-length') || video.size || 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      if (total) onProgress?.(received / total);
    }
  }
  return new File(chunks as BlobPart[], video.name, { type: video.mimeType });
}
