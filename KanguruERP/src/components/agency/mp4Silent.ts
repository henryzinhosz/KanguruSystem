// Cópia muda de um MP4/MOV, feita no navegador e sem recomprimir: tira as faixas de áudio ("trak"
// com handler "soun") de dentro do "moov" e corrige os endereços das amostras (stco/co64) do vídeo
// quando o "moov" vem antes dos dados. Os bytes do áudio continuam no "mdat", só deixam de ser
// usados. Arquivo fragmentado ("moof", comum em gravação de tela) não é suportado.

export type SilentResult =
  | { kind: 'copy'; data: Uint8Array } // cópia sem as faixas de áudio
  | { kind: 'silent' } // o vídeo já não tem áudio
  | { kind: 'unsupported' }; // formato que não dá para tratar aqui

interface Box {
  type: string;
  start: number;
  size: number;
  header: number;
}

const fourcc = (view: DataView, at: number) =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

function readBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = fourcc(view, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) throw new Error('caixa inválida');
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) throw new Error('caixa inválida');
    boxes.push({ type, start: pos, size, header });
    pos += size;
  }
  return boxes;
}

const child = (view: DataView, box: Box, type: string) =>
  readBoxes(view, box.start + box.header, box.start + box.size).find(item => item.type === type);

function handlerOf(view: DataView, trak: Box): string {
  const mdia = child(view, trak, 'mdia');
  const hdlr = mdia ? child(view, mdia, 'hdlr') : undefined;
  if (!hdlr || hdlr.size < hdlr.header + 12) return '';
  return fourcc(view, hdlr.start + hdlr.header + 8);
}

// Desconta "removed" dos endereços que apontam para depois do moov original.
function patchOffsets(view: DataView, trak: Box, limit: number, removed: number) {
  const mdia = child(view, trak, 'mdia');
  const minf = mdia ? child(view, mdia, 'minf') : undefined;
  const stbl = minf ? child(view, minf, 'stbl') : undefined;
  if (!stbl) return;
  for (const table of readBoxes(view, stbl.start + stbl.header, stbl.start + stbl.size)) {
    const content = table.start + table.header;
    if (table.type === 'stco') {
      const count = view.getUint32(content + 4);
      for (let index = 0; index < count; index += 1) {
        const at = content + 8 + index * 4;
        const value = view.getUint32(at);
        if (value >= limit) view.setUint32(at, value - removed);
      }
    } else if (table.type === 'co64') {
      const count = view.getUint32(content + 4);
      for (let index = 0; index < count; index += 1) {
        const at = content + 8 + index * 8;
        const value = view.getBigUint64(at);
        if (value >= BigInt(limit)) view.setBigUint64(at, value - BigInt(removed));
      }
    }
  }
}

export function makeSilentCopy(buffer: ArrayBuffer): SilentResult {
  try {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const top = readBoxes(view, 0, bytes.length);
    const moov = top.find(box => box.type === 'moov');
    if (!moov) return { kind: 'unsupported' };

    const children = readBoxes(view, moov.start + moov.header, moov.start + moov.size);
    const traks = children.filter(box => box.type === 'trak');
    const audio = traks.filter(trak => handlerOf(view, trak) === 'soun');
    if (audio.length === 0) return { kind: 'silent' };
    if (top.some(box => box.type === 'moof')) return { kind: 'unsupported' };
    if (!traks.some(trak => handlerOf(view, trak) === 'vide')) return { kind: 'unsupported' };

    const removed = audio.reduce((sum, trak) => sum + trak.size, 0);
    const moovEnd = moov.start + moov.size;
    const newMoovSize = moov.size - removed;
    if (moov.header === 8 && newMoovSize > 0xffffffff) return { kind: 'unsupported' };

    // Novo moov: cabeçalho + caixas filhas, menos as faixas de áudio.
    const moovBytes = new Uint8Array(newMoovSize);
    moovBytes.set(bytes.subarray(moov.start, moov.start + moov.header), 0);
    let cursor = moov.header;
    for (const box of children) {
      if (audio.includes(box)) continue;
      moovBytes.set(bytes.subarray(box.start, box.start + box.size), cursor);
      cursor += box.size;
    }
    // Sobra entre a última caixa e o fim do moov (raro): copia igual.
    const tailStart = children.length ? children[children.length - 1].start + children[children.length - 1].size : moov.start + moov.header;
    if (tailStart < moovEnd) {
      moovBytes.set(bytes.subarray(tailStart, moovEnd), cursor);
      cursor += moovEnd - tailStart;
    }
    if (cursor !== newMoovSize) return { kind: 'unsupported' };

    const moovView = new DataView(moovBytes.buffer);
    if (moov.header === 16) moovView.setBigUint64(8, BigInt(newMoovSize));
    else moovView.setUint32(0, newMoovSize);

    for (const trak of readBoxes(moovView, moov.header, newMoovSize)) {
      if (trak.type === 'trak') patchOffsets(moovView, trak, moovEnd, removed);
    }

    const result = new Uint8Array(bytes.length - removed);
    result.set(bytes.subarray(0, moov.start), 0);
    result.set(moovBytes, moov.start);
    result.set(bytes.subarray(moovEnd), moov.start + newMoovSize);
    return { kind: 'copy', data: result };
  } catch {
    return { kind: 'unsupported' };
  }
}
