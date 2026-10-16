/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
  SELLER = 'SELLER',
  OPERATOR = 'OPERATOR'
}

export interface User {
  id: string;
  name: string;
  role: UserRole;
  tenantId: string | null;
  unitId: string;
  planCode: string | null;
  subscriptionStatus: 'ATIVO' | 'ATRASADO' | 'BLOQUEADO' | 'CANCELADO' | null;
}

export type SubscriptionStatus = 'ATIVO' | 'ATRASADO' | 'BLOQUEADO' | 'CANCELADO';

export interface PdvOperatorPermissions {
  canRegisterSales: boolean;
  canApplyDiscount: boolean;
  canCancelSales: boolean;
  canOpenCash: boolean;
  canCloseCash: boolean;
}

export interface PdvOperator {
  id: string;
  tenantId: string;
  unitId: string | null;
  code: string | null; // 2 digitos (01-99), unico por loja entre os ativos
  name: string;
  permissions: PdvOperatorPermissions;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PosTerminalActivationStatus = 'PENDENTE' | 'USADO' | 'EXPIRADO' | 'REVOGADO';

export interface PosTerminalActivation {
  id: string;
  codeHash: string;
  tenantId: string;
  unitId: string;
  terminalLabel: string;
  expiresAt: string;
  usedAt: string | null;
  usedByAuthUid: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: PosTerminalActivationStatus;
}

export interface PlatformTenant {
  id: string;
  legalName: string | null;
  tradeName: string | null;
  cnpj: string | null;
  storeCount: number;
  subscriptionStatus: SubscriptionStatus | null;
  createdAt: string;
}

export interface PlatformTenantDetails {
  tenant: {
    id: string;
    legalName: string | null;
    tradeName: string | null;
    cnpj: string | null;
    planCode: string | null;
    subscriptionStatus: SubscriptionStatus | null;
    createdAt: string;
  };
  stores: Array<{
    unitId: string;
    tradeName: string | null;
    legalName: string | null;
    cnpj: string | null;
    createdAt: string;
  }>;
  users: Array<{
    authUid: string;
    email: string | null;
    role: UserRole;
    unitId: string | null;
    createdAt: string | null;
  }>;
}

export interface StoreUnit {
  id: string;
  name: string;
  isStore: boolean; // central is logist hub, others are physical stores
}

export type CardCondition = 'PSA_10' | 'NEAR_MINT' | 'LIGHTLY_PLAYED' | 'MODERATELY_PLAYED' | 'DAMAGED';

export interface ProductVariation {
  id: string;
  name: string; // e.g. "Preto / 1TB"
  skuSuffix: string;
}

export interface KitItem {
  productId: string;
  variationId?: string;
  quantity: number;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: string; // 'Computadores' | 'Peças' | 'Videogames' | 'Cards' | 'Outros'
  brand: string;
  costPrice: number;
  sellPrice: number;
  ncm: string;
  warrantyMonths: number; // calculated warranty automatically from purchase date
  isSerialized: boolean; // true for consoles, notebooks, motherboards, GPUs
  isUsed: boolean; // used vs new
  variations?: ProductVariation[];
  isKit?: boolean;
  kitItems?: KitItem[];
  minStock?: number | null; // estoque minimo para alertas; null = nao definido (usa o padrao)
}

// Custo medio de um produto em uma loja (sem serial: media ponderada;
// com serial: media das unidades em estoque).
export interface ProductStoreCost {
  productId: string;
  unitId: string;
  avgCost: number;
  unitCount: number | null; // so para serializados: unidades em estoque
}

export interface StockEntryLine {
  unitId: string;
  quantity: number;
}

export interface Service {
  id: string;
  sku: string;
  name: string;
  category: string;
  sellPrice: number;
  isActive: boolean;
}

export interface StockQuantity {
  unitId: string;
  qty: number;
  serials?: string[]; // if isSerialized is true, array of serial numbers
  cardConditions?: { [key in CardCondition]?: number }; // if category is 'Cards'
}

export interface StockInventory {
  productId: string;
  quantities: { [unitId: string]: StockQuantity };
}

export interface SerializedStockEntryUnit {
  serialNumber: string;
  imei?: string;
  unitCost?: number;
}

export type MovementType = 'ENTRADA' | 'SAIDA' | 'PERDA' | 'TRANSFERENCIA';

export interface StockMovement {
  id: string;
  productId: string;
  variationId?: string;
  fromUnitId: string | 'FORNECEDOR';
  toUnitId: string | 'CLIENTE' | 'PERDA';
  type: MovementType;
  quantity: number;
  serials?: string[];
  cardCondition?: CardCondition;
  operatorId: string;
  operatorName: string;
  timestamp: string; // ISO string
  reason: string;
}

export interface SaleItem {
  itemType?: 'PRODUCT' | 'SERVICE';
  productId?: string;
  serviceId?: string;
  variationId?: string;
  quantity: number;
  unitPrice: number;
  discountPercent?: number;
  lineTotal?: number;
  serials?: string[]; // serials linked to this item
  cardCondition?: CardCondition;
  // Custo congelado pelo servidor no momento da venda (a partir da 2.7b).
  unitCost?: number;
  costTotal?: number;
}

export type PaymentMethod = 'DINHEIRO' | 'PIX' | 'CREDITO' | 'DEBITO';

// Metodos que podem aparecer em vendas vindas do PDV (inclui o legado
// 'DIVIDIDO', gravado quando a venda tem 2+ linhas em sale_payments).
export type SalePaymentLineMethod = PaymentMethod | 'VOUCHER' | 'CREDIARIO';
export type SalePaymentMethod = SalePaymentLineMethod | 'DIVIDIDO';

export interface SalePaymentLine {
  paymentMethod: SalePaymentLineMethod;
  amount: number; // valor aplicado (troco nao entra; em reserva, ja sem o sinal)
  installments: number;
}

export const SALE_PAYMENT_METHOD_LABELS: Record<SalePaymentMethod, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'Pix',
  CREDITO: 'Crédito',
  DEBITO: 'Débito',
  VOUCHER: 'Voucher',
  CREDIARIO: 'Crediário',
  DIVIDIDO: 'Dividido',
};

export type SaleStatus = 'CONCLUIDA' | 'PENDENTE_APROVACAO' | 'CANCELADA' | 'REJEITADA';

export interface Sale {
  id: string;
  invoiceNumber: string;
  unitId: string;
  items: SaleItem[];
  paymentMethod: SalePaymentMethod;
  payments?: SalePaymentLine[]; // linhas de sale_payments (vendas do PDV a partir da 2.7)
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  operatorId: string;
  operatorName: string;
  clientCpf?: string;
  clientName?: string;
  timestamp: string;
  status: SaleStatus;
  requiresApproval: boolean;
  approvedBy?: string; // admin who approved cancellation or high-value override
  // Vendedor congelado na venda (PDV). Em reserva convertida e quem criou a reserva.
  sellerCode?: string;
  sellerName?: string;
  // Quem finalizou no PDV (difere do vendedor so em reserva convertida).
  finalizedByName?: string;
}

export interface Expense {
  id: string;
  unitId: string;
  description: string;
  category: string; // 'Aluguel' | 'Água/Luz' | 'Salários' | 'Manutenção' | 'Compras Urgentes' | 'Outros'
  amount: number;
  operatorId: string;
  operatorName: string;
  timestamp: string;
}

export interface TradeIn {
  id: string;
  sellerName: string;
  sellerCpf: string;
  itemDescription: string;
  category: string; // 'Videogames' | 'Jogos' | 'Cards' | 'Outros'
  condition: string; // e.g. "Excelente", "Near Mint", etc.
  valuationAmount: number; // purchase price offered
  operatorId: string;
  operatorName: string;
  unitId: string; // 'loja_1' | 'loja_2' | 'loja_3'
  timestamp: string;
  status: 'AVALIADO' | 'APROVADO' | 'CANCELADO';
  createdProductId?: string; // product ID entered into stock after confirmation
}

export type WorkOrderStatus = 'AGUARDANDO_PECA' | 'EM_ANALISE' | 'PRONTO' | 'ENTREGUE';

export interface WorkOrder {
  id: string;
  osNumber: string;
  clientName: string;
  clientPhone: string;
  equipment: string;
  problemDescription: string;
  status: WorkOrderStatus;
  partsCost: number;
  laborCost: number;
  totalCost: number;
  linkedSerial?: string; // link to inventory serial or past sale warranty
  unitId: string;
  operatorId: string;
  operatorName: string;
  timestamp: string;
}

export interface StoreConfig {
  unitId: string;
  fixedCost: number; // for break-even calc
  maxItemDiscountPercent: number;
  tradeName?: string;
  legalName?: string;
  cnpj?: string;
  stateRegistration?: string;
  address?: string;
  phone?: string;
  contactEmail?: string;
  paymentFees: {
    DINHEIRO: number; // percentage (e.g. 0)
    PIX: number; // percentage (e.g. 0.005 = 0.5%)
    CREDITO: number; // percentage (e.g. 0.035 = 3.5%)
    DEBITO: number; // percentage (e.g. 0.019 = 1.9%)
  };
}

export interface Supplier {
  id: string;
  name: string;
  cnpj: string;
  contact: string;
  category: string;
  historyCount: number;
  phone?: string;
  website?: string;
}

export interface SupplierInvoiceReminder {
  id: string;
  supplierId: string;
  supplierName: string;
  description: string;
  amount: number;
  dueDate: string;
  installments: string;
  status: 'PENDENTE' | 'PAGO';
  notes?: string;
  createdAt: string;
}
