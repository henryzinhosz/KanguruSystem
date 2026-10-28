// Montador de comandos ESC/POS (padrao das impressoras termicas: Epson TM-T20 e a maioria).
// Bobina de 80 mm: 48 colunas na fonte normal. Acentos pela pagina de codigo PC860 (portugues).

export const COLUMNS = 48;

// PC860 (portugues): caracteres acentuados -> byte da tabela.
const PC860: Record<string, number> = {
  Ç: 0x80, ü: 0x81, é: 0x82, â: 0x83, ã: 0x84, à: 0x85, Á: 0x86, ç: 0x87, ê: 0x88, Ê: 0x89,
  è: 0x8a, Í: 0x8b, Ô: 0x8c, ì: 0x8d, Ã: 0x8e, Â: 0x8f, É: 0x90, À: 0x91, È: 0x92, ô: 0x93,
  õ: 0x94, ò: 0x95, Ú: 0x96, ù: 0x97, Ì: 0x98, Õ: 0x99, Ü: 0x9a, á: 0xa0, í: 0xa1, ó: 0xa2,
  ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ª: 0xa6, º: 0xa7, Ó: 0x9f, Ò: 0xa9,
};

function encode(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) bytes.push(code);
    else if (PC860[char] != null) bytes.push(PC860[char]);
    else if (char === '\n') bytes.push(0x0a);
    else {
      const plain = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
      bytes.push(plain && plain.charCodeAt(0) < 0x7f ? plain.charCodeAt(0) : 0x3f);
    }
  }
  return bytes;
}

export class EscPos {
  private bytes: number[] = [];

  constructor() {
    // Inicializa e seleciona a pagina de codigo PC860.
    this.raw(0x1b, 0x40, 0x1b, 0x74, 0x03);
  }

  raw(...values: number[]) {
    this.bytes.push(...values);
    return this;
  }

  text(value: string) {
    this.bytes.push(...encode(value));
    return this;
  }

  line(value = '') {
    return this.text(value).raw(0x0a);
  }

  align(mode: 'left' | 'center' | 'right') {
    return this.raw(0x1b, 0x61, mode === 'left' ? 0 : mode === 'center' ? 1 : 2);
  }

  bold(on: boolean) {
    return this.raw(0x1b, 0x45, on ? 1 : 0);
  }

  // Tamanho: 1 = normal, 2 = dobro (largura e altura).
  size(width: 1 | 2, height: 1 | 2) {
    return this.raw(0x1d, 0x21, ((width - 1) << 4) | (height - 1));
  }

  // Texto a esquerda e valor a direita na mesma linha (quebra o texto se nao couber).
  pair(left: string, right: string, columns = COLUMNS) {
    const room = columns - right.length - 1;
    if (left.length > room) {
      this.line(left.slice(0, columns));
      return this.line(right.padStart(columns));
    }
    return this.line(left + ' '.repeat(columns - left.length - right.length) + right);
  }

  rule(char = '-') {
    return this.line(char.repeat(COLUMNS));
  }

  // Quebra um texto longo em linhas de no maximo `columns`.
  wrap(value: string, columns = COLUMNS) {
    const words = value.split(/\s+/);
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).trim().length > columns) {
        this.line(current);
        current = word;
      } else {
        current = (current + ' ' + word).trim();
      }
    }
    if (current) this.line(current);
    return this;
  }

  feed(lines = 1) {
    return this.raw(0x1b, 0x64, lines);
  }

  // QR code (modelo 2), tamanho do modulo 1-16.
  qr(data: string, moduleSize = 6) {
    const payload = encode(data);
    const length = payload.length + 3;
    this.raw(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
    this.raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize);
    this.raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);
    this.raw(0x1d, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, 0x31, 0x50, 0x30, ...payload);
    return this.raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
  }

  // Imagem em preto e branco (GS v 0): largura em pontos multipla de 8.
  image(bits: Uint8Array, widthDots: number, heightDots: number) {
    const bytesPerRow = widthDots / 8;
    this.raw(0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, heightDots & 0xff, (heightDots >> 8) & 0xff);
    this.bytes.push(...bits);
    return this;
  }

  cut() {
    return this.raw(0x1d, 0x56, 0x42, 0x03);
  }

  // Pulso na gaveta de dinheiro (ligada na impressora).
  drawer() {
    return this.raw(0x1b, 0x70, 0x00, 0x19, 0xfa);
  }

  build(): number[] {
    return this.bytes;
  }
}

// Converte uma imagem (logo) em pontos pretos/brancos para a impressora.
export async function imageToBits(url: string, widthDots: number): Promise<{ bits: Uint8Array; width: number; height: number } | null> {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const width = Math.floor(widthDots / 8) * 8;
  const height = Math.max(1, Math.round((image.height / image.width) * width));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const bits = new Uint8Array((width / 8) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const luminance = 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
      if (pixels[index + 3] > 128 && luminance < 150) bits[y * (width / 8) + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { bits, width, height };
}
