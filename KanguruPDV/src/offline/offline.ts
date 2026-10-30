import { useSyncExternalStore } from 'react';
import { supabase } from '../services/supabase/client';
import { recordCashMovement } from '../services/supabase/cash-register';
import type { PosCatalogItem, PosSerialUnit } from '../services/supabase/products';
import type { PosStoreProfile, TerminalContext } from '../services/supabase/terminal';
import type { PosSeller } from '../services/supabase/sellers';
import { offlineStore, type OutboxEntry } from './offlineDb';
import { terminalAuth } from '../services/supabase/auth';

// Modo offline do PDV (desenho aprovado 2026-10-28): copia local dos dados da loja, venda e
// sangria/suprimento sem internet, envio automatico quando a conexao volta.

// ---------- Copia local ----------
export interface OfflineProduct {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  sellPrice: number;
  warrantyMonths: number | null;
  isSerialized: boolean;
  availableQuantity: number;
  maxItemDiscountPercent: number;
  ncm: string | null;
  cest: string | null;
  icmsOrigin: string | null;
  icmsCst: string | null;
  csosn: string | null;
  icmsRate: number | null;
  taxBurdenPercent: number | null;
}

export interface OfflineSnapshot {
  generatedAt: string;
  terminalId: string;
  terminalName: string;
  unitId: string;
  store: PosStoreProfile;
  nfce: { configured: boolean; environment: 'homologacao' | 'producao' | null } | null;
  cash: { id: string; cashNumber: string; openedAt: string; openedByName: string; openingFloatAmount: number } | null;
  products: OfflineProduct[];
  services: { id: string; sku: string; name: string; sellPrice: number; maxItemDiscountPercent: number }[];
  serialUnits: { id: string; productId: string; serialNumber: string; imei: string | null }[];
  sellers: { code: string; name: string }[];
}

const SNAPSHOT_KEY = 'snapshot';
const TERMINAL_KEY = 'terminal';
const PASSWORD_KEY = 'admin-password';
const PASSWORD_VERSION_KEY = 'manager-password-version';
const LAST_RECEIPT_KEY = 'last-offline-receipt';

export async function refreshSnapshot(): Promise<OfflineSnapshot | null> {
  if (!(await ensureTerminalSession())) return null;
  const { data, error } = await supabase.rpc('get_pos_offline_snapshot');
  if (error || !data) return null;
  const snapshot = data as OfflineSnapshot;
  await (await offlineStore()).set(SNAPSHOT_KEY, snapshot);
  return snapshot;
}

export async function getSnapshot(): Promise<OfflineSnapshot | null> {
  return (await (await offlineStore()).get(SNAPSHOT_KEY)) as OfflineSnapshot | null;
}

async function saveSnapshot(snapshot: OfflineSnapshot) {
  await (await offlineStore()).set(SNAPSHOT_KEY, snapshot);
}

export async function cacheTerminal(context: TerminalContext) {
  await (await offlineStore()).set(TERMINAL_KEY, context);
}

export async function getCachedTerminal(): Promise<TerminalContext | null> {
  return (await (await offlineStore()).get(TERMINAL_KEY)) as TerminalContext | null;
}

// Senha Gerente para desbloquear, sangria e gaveta sem internet: so um hash PBKDF2 com sal guardado
// no computador (a senha em si nunca e gravada).
async function hashPassword(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function rememberAdminPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt);
  await (await offlineStore()).set(PASSWORD_KEY, { salt: Array.from(salt), hash });
}

// Senha Gerente trocada no ERP: a copia local da senha antiga deixa de valer
// (volta a valer depois do proximo desbloqueio com internet).
export async function syncManagerPasswordVersion(setAt: string | null) {
  const store = await offlineStore();
  const current = ((await store.get(PASSWORD_VERSION_KEY)) as string | null) ?? null;
  if (current === setAt) return;
  await store.set(PASSWORD_KEY, null);
  await store.set(PASSWORD_VERSION_KEY, setAt);
}

export async function verifyAdminPasswordOffline(password: string): Promise<boolean> {
  const stored = (await (await offlineStore()).get(PASSWORD_KEY)) as { salt: number[]; hash: string } | null;
  if (!stored || !password) return false;
  return (await hashPassword(password, new Uint8Array(stored.salt))) === stored.hash;
}

// ---------- Conexao ----------
export function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  const value = error as { name?: string; message?: string };
  if (value.name === 'OfflineError' || value.name === 'AuthRetryableFetchError' || value.name === 'FunctionsFetchError') return true;
  return /failed to fetch|networkerror|fetch failed|load failed|network request failed|sem conexão/i.test(String(value.message ?? error));
}

export async function probeOnline(): Promise<boolean> {
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string },
      signal: controller.signal,
      cache: 'no-store',
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Estado (faixa "MODO OFFLINE") ----------
interface OfflineState {
  offline: boolean;
  pending: number;
  errors: number;
  syncing: boolean;
}

let state: OfflineState = { offline: false, pending: 0, errors: 0, syncing: false };
const listeners = new Set<() => void>();

function setState(patch: Partial<OfflineState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function isOffline() {
  return state.offline;
}

export function setOffline(value: boolean) {
  if (state.offline !== value) setState({ offline: value });
}

export function useOfflineState(): OfflineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

export async function refreshCounts() {
  const store = await offlineStore();
  const entries = await store.list(['PENDENTE', 'ERRO']);
  setState({
    pending: entries.filter((entry) => entry.status === 'PENDENTE').length,
    errors: entries.filter((entry) => entry.status === 'ERRO').length,
  });
}

export async function listOutboxProblems(): Promise<OutboxEntry[]> {
  return (await offlineStore()).list(['ERRO']);
}

// ---------- Catalogo sem internet ----------
const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function toCatalogItem(product: OfflineProduct): PosCatalogItem {
  return {
    id: product.id,
    itemType: 'PRODUCT',
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    sellPrice: Number(product.sellPrice),
    availableQuantity: product.isSerialized ? serialCount(product.id) : Number(product.availableQuantity),
    warrantyMonths: product.warrantyMonths,
    requiresUnitSelection: product.isSerialized,
    maxItemDiscountPercent: Number(product.maxItemDiscountPercent ?? 0),
    storesWithStock: [],
  };
}

let serialCounts = new Map<string, number>();
function serialCount(productId: string) {
  return serialCounts.get(productId) ?? 0;
}

export async function searchOffline(query: string): Promise<PosCatalogItem[]> {
  const snapshot = await getSnapshot();
  if (!snapshot) return [];
  serialCounts = new Map();
  snapshot.serialUnits.forEach((unit) => serialCounts.set(unit.productId, (serialCounts.get(unit.productId) ?? 0) + 1));
  const term = normalize(query);
  const products = snapshot.products
    .filter((product) => normalize(`${product.sku} ${product.name} ${product.brand ?? ''}`).includes(term))
    .map(toCatalogItem);
  const services: PosCatalogItem[] = snapshot.services
    .filter((service) => normalize(`${service.sku} ${service.name}`).includes(term))
    .map((service) => ({
      id: service.id, itemType: 'SERVICE', sku: service.sku, name: service.name, brand: null,
      sellPrice: Number(service.sellPrice), availableQuantity: 0, warrantyMonths: null,
      requiresUnitSelection: false, maxItemDiscountPercent: Number(service.maxItemDiscountPercent ?? 0), storesWithStock: [],
    }));
  return [...products, ...services].slice(0, 60);
}

export async function offlineSerialUnits(productId: string): Promise<PosSerialUnit[]> {
  const snapshot = await getSnapshot();
  return (snapshot?.serialUnits ?? [])
    .filter((unit) => unit.productId === productId)
    .map((unit) => ({ serialUnitId: unit.id, serialNumber: unit.serialNumber, imei: unit.imei }));
}

export async function findOfflineSerial(code: string): Promise<{ product: PosCatalogItem; unit: PosSerialUnit } | null> {
  const snapshot = await getSnapshot();
  if (!snapshot) return null;
  const term = code.trim().toLowerCase();
  const unit = snapshot.serialUnits.find((item) => item.serialNumber.toLowerCase() === term || item.imei?.toLowerCase() === term);
  const product = unit && snapshot.products.find((item) => item.id === unit.productId);
  if (!unit || !product) return null;
  return { product: toCatalogItem(product), unit: { serialUnitId: unit.id, serialNumber: unit.serialNumber, imei: unit.imei } };
}

export async function findOfflineSeller(code: string): Promise<PosSeller | null> {
  const snapshot = await getSnapshot();
  const normalized = code.trim().padStart(2, '0');
  const seller = snapshot?.sellers.find((item) => item.code === normalized);
  return seller ? { code: seller.code, name: seller.name } : null;
}

export async function offlineProduct(productId: string): Promise<OfflineProduct | null> {
  return (await getSnapshot())?.products.find((product) => product.id === productId) ?? null;
}

// Desconta da copia local o que foi vendido sem internet.
async function applySaleToSnapshot(items: OfflineSaleItem[]) {
  const snapshot = await getSnapshot();
  if (!snapshot) return;
  for (const item of items) {
    if (item.itemType !== 'PRODUCT') continue;
    if (item.serials && item.serials.length > 0) {
      const sold = new Set(item.serials.map((serial) => serial.toLowerCase()));
      snapshot.serialUnits = snapshot.serialUnits.filter((unit) => !(unit.productId === item.productId && sold.has(unit.serialNumber.toLowerCase())));
    } else {
      const product = snapshot.products.find((entry) => entry.id === item.productId);
      if (product) product.availableQuantity = Number(product.availableQuantity) - item.quantity;
    }
  }
  await saveSnapshot(snapshot);
}

// ---------- Venda e movimento sem internet ----------
export interface OfflineSaleItem {
  itemType: 'PRODUCT' | 'SERVICE';
  productId?: string;
  serviceId?: string;
  itemSku: string;
  itemName: string;
  quantity: number;
  discountPercent: number;
  unitPrice: number;
  lineTotal: number;
  serials?: string[];
}

export interface OfflineSalePayload {
  saleId: string;
  invoiceNumber: string;
  timestamp: string;
  cashSessionId: string;
  sellerCode: string;
  sellerName: string;
  clientCpf: string | null;
  clientName: string | null;
  items: OfflineSaleItem[];
  payments: { paymentMethod: string; amount: number }[];
  nfce: Record<string, unknown> | null;
}

export async function enqueueOfflineSale(payload: OfflineSalePayload) {
  const store = await offlineStore();
  await store.enqueue({
    id: payload.saleId, kind: 'SALE', payload: payload as unknown as Record<string, unknown>,
    createdAt: payload.timestamp, status: 'PENDENTE', attempts: 0, lastError: null,
  });
  await applySaleToSnapshot(payload.items);
  await refreshCounts();
}

export async function enqueueOfflineMovement(payload: { type: 'SANGRIA' | 'SUPRIMENTO'; amount: number; reason: string; operatorName: string }) {
  const store = await offlineStore();
  await store.enqueue({
    id: crypto.randomUUID(), kind: 'MOVEMENT', payload: { ...payload, timestamp: new Date().toISOString() },
    createdAt: new Date().toISOString(), status: 'PENDENTE', attempts: 0, lastError: null,
  });
  await refreshCounts();
}

export async function saveLastOfflineReceipt(receipt: unknown) {
  await (await offlineStore()).set(LAST_RECEIPT_KEY, receipt);
}

export async function getLastOfflineReceipt<T>(): Promise<T | null> {
  return (await (await offlineStore()).get(LAST_RECEIPT_KEY)) as T | null;
}

// Mais antiga ainda nao enviada: a NFC-e em contingencia precisa chegar a Sefaz em 24 h.
export async function oldestPendingAt(): Promise<Date | null> {
  const entries = await (await offlineStore()).list(['PENDENTE', 'ERRO']);
  return entries.length > 0 ? new Date(entries[0].createdAt) : null;
}

// ---------- Envio quando a internet volta ----------
let syncRunning = false;

// Garante a sessao do terminal antes de falar com o servidor. Se o PDV foi aberto sem internet,
// a sessao guardada nunca foi carregada (sem ela o servidor recusa tudo como anonimo).
export async function ensureTerminalSession(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (session && (session.expires_at ?? 0) * 1000 > Date.now() + 60 * 1000) return true;
    if (session) {
      const refreshed = await supabase.auth.refreshSession();
      if (refreshed.data.session) return true;
    }
    return (await terminalAuth.restore()) !== null;
  } catch {
    return false;
  }
}

// Recusa por falta de sessao (nao e erro da venda): tenta de novo no proximo ciclo.
function isSessionError(message: string): boolean {
  return /permission denied for function|active terminal session required|jwt|not authenticated/i.test(message);
}

export async function syncOutbox(retryErrors = false): Promise<{ sent: number; failed: number; conflicts: number }> {
  if (syncRunning) return { sent: 0, failed: 0, conflicts: 0 };
  syncRunning = true;
  setState({ syncing: true });
  if (!(await ensureTerminalSession())) {
    syncRunning = false;
    setState({ syncing: false });
    return { sent: 0, failed: 0, conflicts: 0 };
  }
  let sent = 0;
  let failed = 0;
  let conflicts = 0;
  try {
    const store = await offlineStore();
    // Registros que falharam so por falta de sessao voltam a ser enviados sozinhos.
    const entries = (await store.list(['PENDENTE', 'ERRO']))
      .filter((entry) => retryErrors || entry.status === 'PENDENTE' || isSessionError(entry.lastError ?? ''));
    for (const entry of entries) {
      try {
        if (entry.kind === 'SALE') {
          const { data, error } = await supabase.rpc('import_pos_offline_sale', { p_sale: entry.payload });
          if (error) throw error;
          conflicts += Number((data as Record<string, unknown> | null)?.conflicts ?? 0);
        } else {
          const payload = entry.payload as { type: 'SANGRIA' | 'SUPRIMENTO'; amount: number; reason: string; operatorName: string; timestamp: string };
          await recordCashMovement(payload.type, payload.amount, `${payload.reason} (registrado sem internet em ${new Date(payload.timestamp).toLocaleString('pt-BR')})`, payload.operatorName);
        }
        await store.update(entry.id, { status: 'ENVIADO', attempts: entry.attempts + 1, lastError: null });
        sent += 1;
      } catch (error) {
        if (isNetworkError(error)) {
          setOffline(true);
          break;
        }
        const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
        if (isSessionError(message)) {
          await store.update(entry.id, { status: 'PENDENTE', attempts: entry.attempts + 1, lastError: null });
          break;
        }
        await store.update(entry.id, { status: 'ERRO', attempts: entry.attempts + 1, lastError: message.slice(0, 500) });
        failed += 1;
      }
    }
  } finally {
    syncRunning = false;
    setState({ syncing: false });
    await refreshCounts();
  }
  return { sent, failed, conflicts };
}
