import { supabase } from './client';

// Ordem de servico pelo PDV com a sessao do terminal (abrir, acompanhar, entregar).
// A cobranca e uma venda normal: os itens levam workOrderId e o banco liga a venda a OS.

export type WorkOrderStatus = 'EM_ANALISE' | 'AGUARDANDO_PECA' | 'PRONTO' | 'ENTREGUE' | 'DEVOLVIDO';

export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  EM_ANALISE: 'Em análise',
  AGUARDANDO_PECA: 'Aguardando peça',
  PRONTO: 'Pronto',
  ENTREGUE: 'Entregue',
  DEVOLVIDO: 'Devolvido sem conserto',
};

export interface WorkOrderItem {
  serviceId: string;
  sku: string;
  name: string;
  price: number;
}

export interface WorkOrderPaidItem {
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  lineTotal: number;
}

export interface WorkOrderRecord {
  workOrderId: string;
  orderNumber: number;
  status: WorkOrderStatus;
  createdAt: string;
  customerName: string;
  customerCpf: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  equipmentType: string | null;
  equipment: string;
  serialNumber: string | null;
  accessories: string | null;
  entryCondition: string | null;
  devicePassword: string | null;
  notes: string | null;
  items: WorkOrderItem[];
  total: number;
  expectedDate: string | null;
  staffCode: string | null;
  staffName: string | null;
  saleId: string | null;
  paidAt: string | null;
  receiptNumber: number | null;
  paidItems: WorkOrderPaidItem[];
  paidTotal: number | null;
  payments: { paymentMethod: string; amount: number }[];
  deliveredAt: string | null;
  deliveredByCode: string | null;
  deliveredByName: string | null;
  testedOnDelivery: boolean;
  warrantyUntil: string | null;
  terms: string | null;
  deliveryTerms: string | null;
}

export interface NewWorkOrderInput {
  customerCpf: string;
  equipmentType: string;
  equipment: string;
  serialNumber: string;
  accessories: string;
  entryCondition: string;
  devicePassword: string;
  serviceIds: string[];
  notes: string;
  expectedDate: string | null;
  sellerCode: string;
}

export type WorkOrderResult =
  | { status: 'OK'; order: WorkOrderRecord }
  | { status: 'CUSTOMER_REQUIRED' | 'INVALID_SELLER' | 'NOT_PAID' };

const text = (value: unknown) => (value == null || value === '' ? null : String(value));
const numberOrNull = (value: unknown) => (value == null || value === '' ? null : Number(value));

function toRecord(row: Record<string, unknown>): WorkOrderRecord {
  return {
    workOrderId: String(row.workOrderId),
    orderNumber: Number(row.orderNumber),
    status: String(row.status) as WorkOrderStatus,
    createdAt: String(row.createdAt),
    customerName: String(row.customerName ?? ''),
    customerCpf: text(row.customerCpf),
    customerPhone: text(row.customerPhone),
    customerAddress: text(row.customerAddress),
    equipmentType: text(row.equipmentType),
    equipment: String(row.equipment ?? ''),
    serialNumber: text(row.serialNumber),
    accessories: text(row.accessories),
    entryCondition: text(row.entryCondition),
    devicePassword: text(row.devicePassword),
    notes: text(row.notes),
    items: ((row.items ?? []) as Record<string, unknown>[]).map((item) => ({
      serviceId: String(item.serviceId),
      sku: String(item.sku ?? ''),
      name: String(item.name ?? ''),
      price: Number(item.price ?? 0),
    })),
    total: Number(row.total ?? 0),
    expectedDate: text(row.expectedDate),
    staffCode: text(row.staffCode),
    staffName: text(row.staffName),
    saleId: text(row.saleId),
    paidAt: text(row.paidAt),
    receiptNumber: numberOrNull(row.receiptNumber),
    paidItems: ((row.paidItems ?? []) as Record<string, unknown>[]).map((item) => ({
      name: String(item.name ?? ''),
      sku: String(item.sku ?? ''),
      quantity: Number(item.quantity ?? 1),
      unitPrice: Number(item.unitPrice ?? 0),
      discountPercent: Number(item.discountPercent ?? 0),
      lineTotal: Number(item.lineTotal ?? 0),
    })),
    paidTotal: numberOrNull(row.paidTotal),
    payments: ((row.payments ?? []) as Record<string, unknown>[]).map((payment) => ({
      paymentMethod: String(payment.paymentMethod ?? ''),
      amount: Number(payment.amount ?? 0),
    })),
    deliveredAt: text(row.deliveredAt),
    deliveredByCode: text(row.deliveredByCode),
    deliveredByName: text(row.deliveredByName),
    testedOnDelivery: row.testedOnDelivery === true,
    warrantyUntil: text(row.warrantyUntil),
    terms: text(row.terms),
    deliveryTerms: text(row.deliveryTerms),
  };
}

function toResult(data: unknown): WorkOrderResult {
  const row = (data ?? {}) as Record<string, unknown>;
  const status = String(row.status ?? '');
  if (status !== 'OK') return { status: status as 'INVALID_SELLER' };
  return { status: 'OK', order: toRecord((row.order ?? {}) as Record<string, unknown>) };
}

export async function createWorkOrder(input: NewWorkOrderInput): Promise<WorkOrderResult> {
  const { data, error } = await supabase.rpc('create_pos_work_order', {
    p_customer_cpf: input.customerCpf,
    p_equipment_type: input.equipmentType || null,
    p_equipment: input.equipment,
    p_serial: input.serialNumber || null,
    p_accessories: input.accessories || null,
    p_entry_condition: input.entryCondition,
    p_device_password: input.devicePassword || null,
    p_service_ids: input.serviceIds,
    p_notes: input.notes || null,
    p_expected_date: input.expectedDate,
    p_seller_code: input.sellerCode,
  });
  if (error) throw error;
  return toResult(data);
}

export async function listWorkOrders(query: string, includeClosed: boolean): Promise<WorkOrderRecord[]> {
  const { data, error } = await supabase.rpc('list_pos_work_orders', {
    p_query: query.trim() || null,
    p_include_closed: includeClosed,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(toRecord);
}

export async function getWorkOrder(workOrderId: string): Promise<WorkOrderRecord> {
  const { data, error } = await supabase.rpc('get_pos_work_order', { p_work_order_id: workOrderId });
  if (error) throw error;
  return toRecord((data ?? {}) as Record<string, unknown>);
}

export async function updateWorkOrder(
  workOrderId: string,
  changes: { status: WorkOrderStatus; serviceIds: string[]; notes: string; expectedDate: string | null }
): Promise<WorkOrderRecord> {
  const { data, error } = await supabase.rpc('update_pos_work_order', {
    p_work_order_id: workOrderId,
    p_status: changes.status,
    p_service_ids: changes.serviceIds,
    p_notes: changes.notes || null,
    p_expected_date: changes.expectedDate,
  });
  if (error) throw error;
  return toRecord((data ?? {}) as Record<string, unknown>);
}

export async function deliverWorkOrder(
  workOrderId: string,
  sellerCode: string,
  options: { withoutRepair: boolean; tested: boolean }
): Promise<WorkOrderResult> {
  const { data, error } = await supabase.rpc('deliver_pos_work_order', {
    p_work_order_id: workOrderId,
    p_seller_code: sellerCode,
    p_without_repair: options.withoutRepair,
    p_tested: options.tested,
  });
  if (error) throw error;
  return toResult(data);
}
