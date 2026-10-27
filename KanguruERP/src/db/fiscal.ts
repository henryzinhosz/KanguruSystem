// Listas fixas dos dados fiscais do produto (mesmas regras do banco, migration 20261027).
// Ninguem altera nem adiciona: sao as tabelas oficiais.

export const ICMS_ORIGINS: { code: string; label: string }[] = [
  { code: '0', label: '0 – Nacional' },
  { code: '1', label: '1 – Estrangeira, importação direta' },
  { code: '2', label: '2 – Estrangeira, adquirida no mercado interno' },
  { code: '3', label: '3 – Nacional, conteúdo de importação entre 40% e 70%' },
  { code: '4', label: '4 – Nacional, processos produtivos básicos' },
  { code: '5', label: '5 – Nacional, conteúdo de importação até 40%' },
  { code: '6', label: '6 – Estrangeira, importação direta, sem similar nacional' },
  { code: '7', label: '7 – Estrangeira, mercado interno, sem similar nacional' },
  { code: '8', label: '8 – Nacional, conteúdo de importação acima de 70%' },
];

export const ICMS_CSTS = ['00', '10', '20', '30', '40', '41', '50', '51', '60', '70', '90'];

export const CSOSNS = ['101', '102', '103', '201', '202', '203', '300', '400', '500', '900'];

// NCM: 8 digitos (pontos opcionais na digitacao).
export const isValidNcm = (value: string) => /^\d{8}$/.test(value.replace(/\./g, '').trim());

// Codigos com substituicao tributaria: exigem CEST.
const ST_CSOSNS = ['201', '202', '203', '500'];
const ST_CSTS = ['10', '30', '60', '70'];

// Todos os dados fiscais sao obrigatorios para salvar o produto (2.8b). Devolve o motivo ou null.
export function productFiscalError(fields: {
  ncm: string;
  origin: string;
  cst: string;
  csosn: string;
  cest: string;
  icmsRate: number | null;
  icmsReduction: number | null;
  taxBurden: number | null;
}): string | null {
  if (!isValidNcm(fields.ncm)) return 'NCM obrigatório: são 8 números (ex.: 8471.60.52).';
  if (!fields.origin) return 'Informe a Origem da Situação Tributária.';
  if (!fields.csosn && !fields.cst) return 'Informe o CSOSN (Simples Nacional) ou o CST.';
  const cest = fields.cest.replace(/\D/g, '');
  if (cest && cest.length !== 7) return 'CEST inválido: são 7 números (ex.: 21.064.00).';
  if (!cest && (ST_CSOSNS.includes(fields.csosn) || ST_CSTS.includes(fields.cst))) {
    return 'Produto com substituição tributária: informe o CEST.';
  }
  if (fields.icmsRate == null) return 'Informe o ICMS (%). Use 0 se não houver.';
  if (fields.icmsReduction == null) return 'Informe a Redução do ICMS (%). Use 0 se não houver.';
  if (fields.taxBurden == null) return 'Informe o Total de tributos (%).';
  return null;
}
