// Leitura automatica da planilha de precos de um fornecedor (catalogo para pedido de compra).
// Cada aba e analisada sozinha: acha a linha do cabecalho, reconhece as colunas pelo nome,
// descobre a marca (coluna, titulo de secao, nome da aba ou nome do produto), o tipo
// (coluna ou 1a palavra do nome) e calcula o preco real (com IPI menos o desconto).
// O que o usuario corrigir na tela de conferencia fica em CatalogReadingConfig e e
// reaproveitado na proxima planilha do mesmo fornecedor.

export type ColumnRole =
  | 'code'
  | 'name'
  | 'brand'
  | 'type'
  | 'status'
  | 'priceNoIpi'
  | 'priceIpi'
  | 'ipi'
  | 'discount'
  | 'finalPrice';

export const COLUMN_ROLE_LABELS: Record<ColumnRole, string> = {
  code: 'Código',
  name: 'Produto',
  brand: 'Marca',
  type: 'Tipo',
  status: 'Situação',
  priceNoIpi: 'Preço sem IPI',
  priceIpi: 'Preço com IPI',
  ipi: 'IPI',
  discount: 'Desconto',
  finalPrice: 'Preço final',
};

export interface SheetReadingConfig {
  include: boolean;
  headerRow: number; // indice (0 = primeira linha)
  columns: Partial<Record<ColumnRole, number>>;
  fixedBrand: string; // marca da aba inteira quando nao ha coluna (vazio = automatico)
  typeSource: 'column' | 'firstWord';
}

export interface CatalogReadingConfig {
  sheets: Record<string, SheetReadingConfig>;
  brandAliases: Record<string, string>; // texto da planilha (normalizado) -> marca
  typeAliases: Record<string, string>; // 1a palavra/tipo (normalizado) -> tipo
}

export interface ParsedCatalogItem {
  key: string;
  sheet: string;
  row: number; // linha no Excel (1 = primeira)
  code: string;
  name: string;
  rawBrand: string;
  brand: string;
  rawType: string;
  type: string;
  status: string;
  cost: number;
  priceDetails: { noIpi?: number; withIpi?: number; ipiPercent?: number; discountPercent?: number; finalPrice?: number };
  warnings: string[];
}

export interface ParsedSheet {
  name: string;
  rows: unknown[][];
  config: SheetReadingConfig;
  headers: string[];
  autoDetected: boolean;
  costMethod: string;
  costMismatch: number; // linhas em que o calculo nao bateu com a coluna de preco final
  items: ParsedCatalogItem[];
}

export interface ParsedCatalog {
  sheets: ParsedSheet[];
  items: ParsedCatalogItem[];
  config: CatalogReadingConfig;
}

export const emptyReadingConfig = (): CatalogReadingConfig => ({ sheets: {}, brandAliases: {}, typeAliases: {} });

export const normalizeText = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

const titleCase = (value: string) =>
  value.toLowerCase().replace(/(^|[\s/-])([a-zà-ú])/g, (_, sep: string, letter: string) => sep + letter.toUpperCase());

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const clean = value.replace(/R\$|\s|%/g, '');
  if (!clean) return null;
  const normalized = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

// Percentual pode vir como 0,23 (fracao) ou 23 (%).
const toFraction = (value: unknown): number | null => {
  const parsed = toNumber(value);
  if (parsed == null) return null;
  return parsed > 1 ? parsed / 100 : parsed;
};

// Nomes de coluna reconhecidos (ja normalizados, sem acento).
function headerRole(header: string): ColumnRole | 'ignore' | null {
  const h = normalizeText(header);
  if (!h) return null;
  if (/MINIMO|SUGERID|QUANT|^QTD|^TOTAL|ESTOQUE|NCM|EAN|BARRA|FOTO|IMAGEM/.test(h)) return 'ignore';
  if (/^(COD|CODIGO|COD\.|REF|REFERENCIA|SKU|PART ?NUMBER|PN|CODIGO DO PRODUTO)\b/.test(h)) return 'code';
  if (/^(PRODUTO|DESCRICAO|DESCRICAO DO PRODUTO|ITEM|NOME|MODELO)\b/.test(h)) return 'name';
  if (/^(MARCA|FABRICANTE)\b/.test(h)) return 'brand';
  if (/^(FAMILIA|TIPO|CATEGORIA|GRUPO|SEGMENTO|LINHA DE PRODUTO|SUBGRUPO)\b/.test(h)) return 'type';
  if (/^(STATUS|SITUACAO)\b/.test(h)) return 'status';
  if (/DESC/.test(h)) return 'discount';
  if (/SEM IPI/.test(h)) return 'priceNoIpi';
  if (/(COM|C\/) ?IPI/.test(h) && /PRECO|VALOR|R\$/.test(h)) return 'priceIpi';
  if (/^IPI\b/.test(h)) return 'ipi';
  if (/PRECO|VALOR|CUSTO|UNITARIO|R\$/.test(h)) return 'finalPrice';
  return null;
}

function detectHeader(rows: unknown[][]): { headerRow: number; columns: Partial<Record<ColumnRole, number>> } | null {
  let best: { headerRow: number; columns: Partial<Record<ColumnRole, number>>; score: number } | null = null;
  const limit = Math.min(rows.length, 40);
  for (let r = 0; r < limit; r += 1) {
    const row = rows[r] || [];
    const columns: Partial<Record<ColumnRole, number>> = {};
    const priceIpiCols: number[] = [];
    let score = 0;
    row.forEach((cell, c) => {
      if (typeof cell !== 'string') return;
      const role = headerRole(cell);
      if (!role || role === 'ignore') return;
      if (role === 'priceIpi') {
        priceIpiCols.push(c);
        score += 1;
        return;
      }
      // IPI pode aparecer duas vezes (% e fracao): fica a primeira.
      if (columns[role] === undefined || role === 'finalPrice') {
        if (columns[role] === undefined) score += 1;
        columns[role] = c;
      }
    });
    // Duas colunas "com IPI": a primeira e o preco de tabela, a ultima (depois do desconto) e o preco final.
    if (priceIpiCols.length > 0) {
      columns.priceIpi = priceIpiCols[0];
      if (priceIpiCols.length > 1) columns.finalPrice = priceIpiCols[priceIpiCols.length - 1];
    }
    if (columns.name === undefined) continue;
    if (!best || score > best.score) best = { headerRow: r, columns, score };
  }
  return best && best.score >= 2 ? { headerRow: best.headerRow, columns: best.columns } : null;
}

const GENERIC_SHEET = /^(TABELA|PLANILHA|SHEET|PLAN|LISTA|PRECO|PRECOS|INFORMATICA|PAPELARIA|GAMER|GERAL|PRODUTOS)\b/;

// Abreviacoes comuns de tipo nas listas de fornecedor.
const TYPE_ABBREVIATIONS: Record<string, string> = {
  ETIQ: 'ETIQUETA',
  CART: 'CARTUCHO',
  CAB: 'CABO',
  ADAPT: 'ADAPTADOR',
  CARREG: 'CARREGADOR',
  TECL: 'TECLADO',
  CX: 'CAIXA',
};

function cellText(row: unknown[], col: number | undefined) {
  if (col === undefined) return '';
  const value = row[col];
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function readSheet(name: string, rows: unknown[][], config: SheetReadingConfig, typeAliases: Record<string, string>) {
  const { columns } = config;
  const items: ParsedCatalogItem[] = [];
  let section = '';
  let costMismatch = 0;
  let usedMethod = '';
  for (let r = config.headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const filled = row.filter(cell => cell != null && String(cell).trim() !== '');
    if (filled.length === 0) continue;
    const productName = cellText(row, columns.name);
    const code = cellText(row, columns.code);
    const prices = (['priceNoIpi', 'priceIpi', 'finalPrice'] as const).map(role => toNumber(columns[role] === undefined ? null : row[columns[role]!]));
    // Linha de titulo (so um texto, sem preco): marca/secao para os itens abaixo.
    if (filled.length === 1 && typeof filled[0] === 'string' && prices.every(price => price == null)) {
      section = String(filled[0]).trim();
      continue;
    }
    if (!productName || (!code && prices.every(price => price == null))) continue;

    const noIpi = toNumber(columns.priceNoIpi === undefined ? null : row[columns.priceNoIpi]);
    const withIpiRaw = toNumber(columns.priceIpi === undefined ? null : row[columns.priceIpi]);
    const ipi = toFraction(columns.ipi === undefined ? null : row[columns.ipi]);
    const discount = toFraction(columns.discount === undefined ? null : row[columns.discount]);
    const finalPrice = toNumber(columns.finalPrice === undefined ? null : row[columns.finalPrice]);
    const withIpi = withIpiRaw ?? (noIpi != null ? noIpi * (1 + (ipi ?? 0)) : null);

    // Preco real: com IPI menos o desconto; confere com a coluna de preco final quando existir.
    let cost = 0;
    const warnings: string[] = [];
    if (withIpi != null && discount != null) {
      cost = withIpi * (1 - discount);
      usedMethod = 'Preço com IPI menos o desconto';
      if (finalPrice != null && Math.abs(finalPrice - cost) > Math.max(0.02, cost * 0.01)) {
        costMismatch += 1;
        warnings.push(`O cálculo (${cost.toFixed(2)}) não bate com o preço final da planilha (${finalPrice.toFixed(2)})`);
      } else if (finalPrice != null) {
        usedMethod = 'Preço com IPI menos o desconto (confere com a coluna de preço final)';
      }
    } else if (finalPrice != null) {
      cost = finalPrice;
      usedMethod = 'Coluna de preço final';
    } else if (withIpi != null) {
      cost = withIpi;
      usedMethod = 'Preço com IPI';
    } else if (noIpi != null) {
      cost = noIpi;
      usedMethod = 'Preço sem IPI';
    }
    cost = Math.round(cost * 10000) / 10000;
    if (!(cost > 0)) warnings.push('Preço zerado na planilha: confirme com o fornecedor');

    const rawBrand = cellText(row, columns.brand) || config.fixedBrand || section;
    let rawType = config.typeSource === 'column' ? cellText(row, columns.type) : '';
    if (!rawType) rawType = productName.split(' ')[0] || '';
    const typeKey = normalizeText(rawType).replace(/\.$/, '');
    items.push({
      key: normalizeText(code) || `NOME:${normalizeText(productName)}`,
      sheet: name,
      row: r + 1,
      code,
      name: productName,
      rawBrand,
      brand: '',
      rawType,
      type: titleCase(typeAliases[typeKey] || TYPE_ABBREVIATIONS[typeKey] || typeKey),
      status: cellText(row, columns.status).toUpperCase(),
      cost,
      priceDetails: {
        ...(noIpi != null ? { noIpi } : {}),
        ...(withIpi != null ? { withIpi } : {}),
        ...(ipi != null ? { ipiPercent: Math.round(ipi * 10000) / 100 } : {}),
        ...(discount != null ? { discountPercent: Math.round(discount * 10000) / 100 } : {}),
        ...(finalPrice != null ? { finalPrice } : {}),
      },
      warnings,
    });
  }
  return { items, costMismatch, costMethod: usedMethod || 'Sem coluna de preço reconhecida' };
}

// Marca: junta grafias parecidas (DAZ/DAZZ) e abreviacoes (MAX -> MAXPRINT, quando a marca
// completa aparece nos nomes dos produtos). Sem marca: nome da aba ou marca conhecida no nome.
function resolveBrands(sheets: ParsedSheet[], aliases: Record<string, string>) {
  const all = sheets.flatMap(sheet => sheet.items);
  const rawCounts = new Map<string, number>();
  all.forEach(item => {
    const key = normalizeText(item.rawBrand);
    if (key) rawCounts.set(key, (rawCounts.get(key) || 0) + 1);
  });
  const automatic: Record<string, string> = {};
  const raws = [...rawCounts.keys()];
  raws.forEach(raw => {
    // Palavra do nome que comeca com a abreviacao e aparece em varios itens dessa marca.
    const words = new Map<string, number>();
    all.filter(item => normalizeText(item.rawBrand) === raw).forEach(item => {
      new Set(normalizeText(item.name).split(/[\s\-/]+/)).forEach(word => {
        if (word.length > raw.length && word.startsWith(raw)) words.set(word, (words.get(word) || 0) + 1);
      });
    });
    const best = [...words.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 3) automatic[raw] = best[0];
  });
  raws.forEach(raw => {
    // DAZ e DAZZ: a mais curta vira a mais longa (diferenca de ate 2 letras).
    const longer = raws.find(other => other !== raw && other.startsWith(raw) && other.length - raw.length <= 2);
    if (longer && !automatic[raw]) automatic[raw] = automatic[longer] || longer;
  });
  const brandOf = (raw: string) => {
    const key = normalizeText(raw);
    if (!key) return '';
    return aliases[key] || titleCase(automatic[key] || key);
  };
  const known = new Set(raws.map(raw => normalizeText(brandOf(raw))));
  sheets.forEach(sheet => {
    const sheetKey = normalizeText(sheet.name);
    const sheetIsBrand = sheetKey && !GENERIC_SHEET.test(sheetKey)
      && sheet.items.filter(item => normalizeText(item.name).includes(sheetKey)).length >= sheet.items.length * 0.5;
    sheet.items.forEach(item => {
      let brand = brandOf(item.rawBrand);
      if (!brand && sheetIsBrand) brand = aliases[sheetKey] || titleCase(sheetKey);
      if (!brand) {
        const name = ` ${normalizeText(item.name)} `;
        const found = [...known].find(candidate => candidate && name.includes(` ${candidate} `));
        if (found) brand = titleCase(found);
      }
      item.brand = brand;
      if (!brand) item.warnings.push('Sem marca: escolha a marca desta aba na conferência');
    });
  });
}

// Tipo pela 1a palavra: junta abreviacoes que sao inicio de outra palavra frequente (ETIQ -> ETIQUETA).
function mergeTypePrefixes(items: ParsedCatalogItem[], aliases: Record<string, string>) {
  const counts = new Map<string, number>();
  items.forEach(item => counts.set(normalizeText(item.type), (counts.get(normalizeText(item.type)) || 0) + 1));
  const keys = [...counts.keys()];
  items.forEach(item => {
    const key = normalizeText(item.type);
    if (aliases[key]) {
      item.type = titleCase(aliases[key]);
      return;
    }
    if (key.length < 3) return;
    // Plural (ETIQUETAS, MARCADORES) vira o singular quando ele existe na lista.
    const singular = [key.replace(/ES$/, ''), key.replace(/S$/, '')].find(other => other !== key && counts.has(other));
    if (singular) {
      item.type = titleCase(singular);
      return;
    }
    const target = keys.find(other => other !== key && other.startsWith(key) && (counts.get(other) || 0) >= (counts.get(key) || 0));
    if (target) item.type = titleCase(target);
  });
}

// O leitor de Excel so e carregado na hora de importar (deixa o ERP mais leve).
export async function readWorkbook(data: ArrayBuffer): Promise<Record<string, unknown[][]>> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(data, { type: 'array' });
  const result: Record<string, unknown[][]> = {};
  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: true });
    // A leitura comeca na primeira linha usada; completa o topo para o indice ser a linha real do Excel.
    const top = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).s.r : 0;
    result[sheetName] = [...Array.from({ length: top }, () => [] as unknown[]), ...rows];
  });
  return result;
}

// Analisa todas as abas usando a configuracao salva quando o cabecalho for o mesmo.
export function parseCatalog(workbook: Record<string, unknown[][]>, saved: CatalogReadingConfig | null): ParsedCatalog {
  const base = saved || emptyReadingConfig();
  const config: CatalogReadingConfig = { sheets: {}, brandAliases: { ...base.brandAliases }, typeAliases: { ...base.typeAliases } };
  const sheets: ParsedSheet[] = [];
  Object.entries(workbook).forEach(([name, rows]) => {
    const previous = base.sheets[name];
    const detected = detectHeader(rows);
    let sheetConfig: SheetReadingConfig;
    let autoDetected = true;
    if (previous && previous.headerRow < rows.length) {
      sheetConfig = previous;
      autoDetected = false;
    } else if (detected) {
      sheetConfig = {
        include: true,
        headerRow: detected.headerRow,
        columns: detected.columns,
        fixedBrand: '',
        typeSource: detected.columns.type !== undefined ? 'column' : 'firstWord',
      };
    } else {
      sheetConfig = { include: false, headerRow: 0, columns: {}, fixedBrand: '', typeSource: 'firstWord' };
    }
    config.sheets[name] = sheetConfig;
    const headers = (rows[sheetConfig.headerRow] || []).map(cell => (cell == null ? '' : String(cell).trim()));
    const read = sheetConfig.include && sheetConfig.columns.name !== undefined
      ? readSheet(name, rows, sheetConfig, config.typeAliases)
      : { items: [], costMismatch: 0, costMethod: '' };
    sheets.push({ name, rows, config: sheetConfig, headers, autoDetected, ...read });
  });
  resolveBrands(sheets, config.brandAliases);
  const items = sheets.flatMap(sheet => sheet.items);
  mergeTypePrefixes(items, config.typeAliases);
  // Nomes corrigidos na conferencia (marca ou tipo ja resolvido -> nome escolhido).
  items.forEach(item => {
    const brandRename = config.brandAliases[normalizeText(item.brand)];
    if (item.brand && brandRename) item.brand = brandRename;
    const typeRename = config.typeAliases[normalizeText(item.type)];
    if (item.type && typeRename) item.type = titleCase(typeRename);
  });
  return { sheets, items, config };
}

// Ligacao com o cadastro: produtos do franqueado mais parecidos com o nome do item.
export function suggestProducts<T extends { id: string; name: string; sku?: string }>(itemName: string, products: T[], limit = 5): T[] {
  const tokens = (value: string) => new Set(normalizeText(value).split(/[^A-Z0-9]+/).filter(token => token.length >= 2));
  const target = tokens(itemName);
  if (target.size === 0) return [];
  return products
    .map(product => {
      const other = tokens(product.name);
      let shared = 0;
      target.forEach(token => {
        if (other.has(token)) shared += /\d/.test(token) ? 3 : 1; // modelo (M90, K120) pesa mais
      });
      return { product, score: shared / Math.sqrt(target.size * Math.max(other.size, 1)) };
    })
    .filter(entry => entry.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.product);
}
