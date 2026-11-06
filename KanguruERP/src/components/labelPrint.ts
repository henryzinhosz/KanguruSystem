// Etiquetas de produto (2.7b Parte 3): impressas pela janela de impressao do navegador,
// usando o driver da impressora de etiquetas instalada no Windows (ex.: App Tech 320B).
// Tamanhos: 60x40 mm e 60x30 mm. Codigo de barras Code 128 (aceita letras, numeros e hifen).
// Produto com serial: uma etiqueta por unidade, com DOIS codigos de barras (codigo do produto
// e serial), para o vendedor bipar qualquer um dos dois.

export type LabelSize = '60x40' | '60x30';

export interface LabelData {
  name: string;
  price: number;
  code: string;
  serial?: string;
}

// Tabela padrao do Code 128 (larguras barra/espaco em modulos), valores 0..106.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const STOP = 106;

// Valores do Code 128: so numeros (4+ digitos) usa o conjunto C (mais compacto);
// o resto usa o conjunto B.
function code128Values(text: string): number[] {
  const clean = Array.from(text).filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126).join('');
  const values: number[] = [];
  if (/^[0-9]{4,}$/.test(clean)) {
    const evenPart = clean.length % 2 === 0 ? clean : clean.slice(0, -1);
    values.push(START_C);
    for (let index = 0; index < evenPart.length; index += 2) values.push(Number(evenPart.slice(index, index + 2)));
    if (evenPart.length !== clean.length) {
      values.push(CODE_B);
      values.push(clean.charCodeAt(clean.length - 1) - 32);
    }
  } else {
    values.push(START_B);
    for (const char of clean) values.push(char.charCodeAt(0) - 32);
  }
  const checksum = values.reduce((sum, value, index) => sum + value * (index === 0 ? 1 : index), 0) % 103;
  values.push(checksum, STOP);
  return values;
}

// SVG do codigo de barras. Largura total em mm; a altura vem do CSS.
export function code128Svg(text: string, maxWidthMm: number): string {
  const widths = code128Values(text).map(value => PATTERNS[value]).join('');
  const quiet = 8;
  let x = quiet;
  const bars: string[] = [];
  Array.from(widths).forEach((digit, index) => {
    const width = Number(digit);
    if (index % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${width}" height="10"/>`);
    x += width;
  });
  const total = x + quiet;
  // Modulo de 0,25 mm (2 pontos em 203 dpi) quando cabe; senao encolhe para caber na etiqueta.
  const widthMm = Math.min(maxWidthMm, total * 0.25);
  return `<svg class="bars" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} 10" preserveAspectRatio="none" shape-rendering="crispEdges" style="width:${widthMm.toFixed(2)}mm">${bars.join('')}</svg>`;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function labelHtml(label: LabelData, size: LabelSize): string {
  const e = escapeHtml;
  const usable = 56;
  const name = `<div class="name">${e(label.name)}</div>`;
  const price = `<div class="price">${money.format(label.price)}</div>`;
  const codeBlock = `<div class="code">${code128Svg(label.code, usable)}<div class="caption">Cód: ${e(label.code)}</div></div>`;
  const serialBlock = label.serial
    ? `<div class="code">${code128Svg(label.serial, usable)}<div class="caption">Serial: ${e(label.serial)}</div></div>`
    : '';
  return `<section class="label ${size === '60x30' ? 'small' : ''} ${label.serial ? 'with-serial' : ''}">${name}${price}${codeBlock}${serialBlock}</section>`;
}

export function buildLabelsHtml(labels: LabelData[], size: LabelSize): string {
  const height = size === '60x30' ? 30 : 40;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Etiquetas</title>
<style>
  @page { size: 60mm ${height}mm; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; }
  .label { width: 60mm; height: ${height}mm; padding: 1.5mm 2mm; overflow: hidden; display: flex; flex-direction: column; align-items: center; page-break-after: always; break-after: page; }
  .label:last-child { page-break-after: auto; break-after: auto; }
  .name { width: 100%; font-size: 8.5pt; font-weight: bold; line-height: 1.15; text-align: center; max-height: 2.3em; overflow: hidden; }
  .price { font-size: 14pt; font-weight: bold; line-height: 1.1; margin: 0.4mm 0 0.6mm; }
  .code { display: flex; flex-direction: column; align-items: center; }
  .bars { display: block; height: 11mm; fill: #000; }
  .with-serial .bars { height: 6.5mm; }
  .caption { font-size: 7pt; font-weight: bold; line-height: 1.1; margin-top: 0.3mm; }
  .with-serial .code + .code { margin-top: 0.8mm; }
  .small { padding: 1mm 2mm; }
  .small .name { font-size: 7.5pt; max-height: 1.15em; white-space: nowrap; text-overflow: ellipsis; }
  .small .price { font-size: 11pt; margin: 0.2mm 0 0.4mm; }
  .small .bars { height: 8mm; }
  .small.with-serial .bars { height: 5mm; }
  .small .caption { font-size: 6pt; }
  .small.with-serial .code + .code { margin-top: 0.4mm; }
</style>
</head>
<body>
${labels.map(label => labelHtml(label, size)).join('\n')}
</body>
</html>`;
}

// Mesmo jeito dos outros impressos do ERP: iframe invisivel (nao e bloqueado como pop-up).
export function printLabels(labels: LabelData[], size: LabelSize) {
  if (labels.length === 0) return;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', right: '0', bottom: '0' });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(buildLabelsHtml(labels, size));
  doc.close();
  win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500), { once: true });
  setTimeout(() => {
    win.focus();
    win.print();
    setTimeout(() => frame.isConnected && frame.remove(), 60000);
  }, 150);
}

const SIZE_KEY = 'kanguru.labelSize';

export function loadLabelSize(): LabelSize {
  try {
    return localStorage.getItem(SIZE_KEY) === '60x30' ? '60x30' : '60x40';
  } catch {
    return '60x40';
  }
}

export function saveLabelSize(size: LabelSize) {
  try {
    localStorage.setItem(SIZE_KEY, size);
  } catch {
    // sem armazenamento: so nao lembra a escolha
  }
}
