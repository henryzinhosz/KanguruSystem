import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  CircleAlert,
  ClipboardList,
  CreditCard,
  LayoutGrid,
  LockKeyhole,
  Minus,
  Plus,
  ScanBarcode,
  Search,
  Trash2,
  UserRound,
  WalletCards,
  X,
} from 'lucide-react';
import { terminalAuth } from '../services/supabase/auth';
import ValueInput, { formatValueText, parseValueText } from './ValueInput';
import { formatCpf, printReservationVoucher, type ReservationVoucherData } from './reservationVoucher';
import { isValidCpf, maskCpf } from './cpf';
import { CustomerFormModal, CustomerPickerModal } from './CustomerModals';
import { WarrantyPanel } from './WarrantyPanel';
import type { PosCustomer } from '../services/supabase/customers';
import {
  findPosSerialUnit,
  getPosAvailableSerialUnits,
  searchPosItems,
  type PosCatalogItem,
  type PosSerialUnit,
} from '../services/supabase/products';
import {
  emitPosNfce,
  getPosNfceStatus,
  getPosCardFees,
  getPosSaleReceipt,
  cardFeeRate,
  lineSurcharge,
  saleRpc,
  syncNfceContingency,
  type CardFeeTable,
  type NfceStatus,
  type PaymentLine,
  type PaymentMethodKey,
  type PosNfceStatus,
} from '../services/supabase/sales';
import { ReceiptsPanel } from './ReceiptsPanel';
import { ReturnModal, type ReturnDone } from './ReturnModal';
import { TradeInPanel, type TradeInDone } from './TradeInPanel';
import { WorkOrdersPanel, type WorkOrderCharge } from './WorkOrdersPanel';
import { deliverWorkOrder, getWorkOrder } from '../services/supabase/workOrders';
import { printWorkOrder } from './workOrderPrint';
import { getCustomerCreditBalance } from '../services/supabase/returns';
import { searchPosCustomers } from '../services/supabase/customers';
import { setUpdateAllowed } from './UpdateNotice';
import { getVersion } from '@tauri-apps/api/app';
import { TopBar } from './TopBar';
import { HomeMenu, type MenuAction } from './HomeMenu';
import { ProductLookupModal } from './ProductLookupModal';
import { PrinterSettingsModal } from './PrinterSettingsModal';
import { getDirectPrinter, openCashDrawer } from '../printing/directPrint';
import {
  cacheTerminal,
  enqueueOfflineMovement,
  enqueueOfflineSale,
  findOfflineSeller,
  findOfflineSerial,
  getCachedTerminal,
  getLastOfflineReceipt,
  getSnapshot,
  isNetworkError,
  isOffline,
  offlineSerialUnits,
  oldestPendingAt,
  probeOnline,
  refreshCounts,
  refreshSnapshot,
  rememberAdminPassword,
  saveLastOfflineReceipt,
  searchOffline,
  setOffline,
  syncOutbox,
  useOfflineState,
  verifyAdminPasswordOffline,
  syncManagerPasswordVersion,
  type OfflineSaleItem,
  type OfflineSalePayload,
} from '../offline/offline';
import { emitLocalNfce, getComunicadorPort, setComunicadorPort } from '../offline/comunicador';
import { OfflineCustomerModal } from './OfflineCustomerModal';
import type { PosSaleReceipt } from '../services/supabase/sales';
import { printClosingReport, printManagerialReport, type ManagerialReport } from './cashReportPrint';
import { printSaleReceipt } from './receiptPrint';
import {
  cancelPosReservation,
  createPosReservation,
  getPosReservations,
  type PosReservation,
  type ReservationLineInput,
} from '../services/supabase/reservations';
import { findPosSeller, normalizeSellerCode, type PosSeller } from '../services/supabase/sellers';
import {
  activateTerminal,
  getPosStoreProfile,
  getTerminalContext,
  requireAdminPassword,
  getManagerPasswordStatus,
  authorizeManager,
  type ManagerAction,
  type PosStoreProfile,
  type TerminalContext,
} from '../services/supabase/terminal';
import {
  closeCashSession,
  getCashClosureSummary,
  getCashSessionReport,
  type CashSessionReport,
  getOpenCashSession,
  openCashSession,
  recordCashMovement,
  type CashClosureSummary,
  type CashCounts,
  type CashSession,
} from '../services/supabase/cash-register';

type Screen =
  | 'loading'
  | 'menu'
  | 'activation'
  | 'set-password'
  | 'unlock'
  | 'cash-open'
  | 'sale'
  | 'reservations'
  | 'new-reservation'
  | 'receipts'
  | 'warranty'
  | 'trade-in'
  | 'work-orders'
  | 'cash-movement'
  | 'cash-close';
type PaymentMethod = PaymentMethodKey;
type MovementType = 'SANGRIA' | 'SUPRIMENTO';
type FiscalChoice = 'NAO_FISCAL' | 'NFCE';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'Pix',
  CREDITO: 'Crédito',
  DEBITO: 'Débito',
  VOUCHER: 'Vale-troca',
  CREDIARIO: 'Crediário',
};

interface CartItem extends PosCatalogItem {
  quantity: number;
  discountPercent: number;
  serialUnit?: PosSerialUnit;
  // Encomenda: sem estoque agora; so pode ser reservado.
  backorder?: boolean;
  // Servico de uma Ordem de Servico sendo cobrada (o banco liga a venda a OS).
  workOrderId?: string;
  workOrderNumber?: number;
}

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const emptyCounts: CashCounts = {
  cash: 0,
  pix: 0,
  credit: 0,
  debit: 0,
  voucher: 0,
  creditAccount: 0,
};

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : 'Ocorreu um erro inesperado.';

  const discountLimitError = message.match(/Discount exceeds the store limit of ([\d.]+) percent/i);
  if (discountLimitError) {
    return `Desconto bloqueado. O limite deste item é ${discountLimitError[1]}%.`;
  }

  if (message.includes('Manager password is not configured')) {
    return 'A loja ainda não tem senha Gerente. Cadastre no ERP › Configurações (na loja).';
  }
  if (message.includes('Manager password required')) {
    return 'Esta ação precisa da senha Gerente. Tente de novo.';
  }
  const passwordLockedError = message.match(/Administrative password locked until (.+)$/i);
  if (passwordLockedError) {
    return passwordLockedMessage(passwordLockedError[1]);
  }
  if (message.includes('Counted amounts cannot be negative')) {
    return 'A contagem não pode ser negativa. Digite o valor que realmente está no caixa (pode ser 0).';
  }
  if (message.includes('Invalid administrative password')) {
    return 'Senha Gerente incorreta.';
  }
  if (message.includes('Administrative password required')) {
    return 'Informe a senha Gerente para liberar o desconto.';
  }
  if (message.includes('Payment lines do not match the sale total')) {
    return 'A soma das formas de pagamento não confere com o total da venda.';
  }
  if (message.includes('Customer CPF is required')) {
    return 'Informe um CPF válido do cliente para registrar a reserva.';
  }
  if (message.includes('Insufficient physical stock for reserved product') || /Product .+ was not found in inventory/.test(message)) {
    return 'O produto desta reserva ainda não chegou no estoque da loja. Dê entrada no estoque antes de entregar.';
  }
  if (message.includes('Select the arrived unit for the backorder line')) {
    return 'Escolha a unidade (serial) que chegou para cada item de encomenda.';
  }
  if (message.includes('Selected serialized unit is not available')) {
    return 'A unidade escolhida não está mais disponível. Escolha outra.';
  }

  return message.includes('Anonymous sign-ins are disabled')
    ? 'Habilite Anonymous Sign-Ins em Authentication > Providers no projeto Supabase antes de ativar terminais.'
    : message;
}

function passwordLockedMessage(lockedUntil: string): string {
  const date = new Date(lockedUntil);
  const time = Number.isNaN(date.getTime())
    ? lockedUntil
    : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `Senha Gerente bloqueada por excesso de tentativas. Tente novamente às ${time}.`;
}

function toCents(value: number): number {
  return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) : 0;
}

interface PaymentResolution {
  // Valores aplicados (troco ja descontado do dinheiro): e o que vai para o servidor.
  applied: PaymentLine[];
  sumCents: number;
  missingCents: number;
  changeCents: number;
  error: string | null;
}

// Troco so existe em dinheiro: o excedente sobre o total e abatido das linhas
// em dinheiro (da ultima para a primeira). O servidor recebe so o valor aplicado.
function resolvePayments(lines: PaymentLine[], total: number): PaymentResolution {
  const totalCents = toCents(total);
  const sumCents = lines.reduce((sum, line) => sum + toCents(line.amount), 0);
  const cashCents = lines.reduce(
    (sum, line) => sum + (line.paymentMethod === 'DINHEIRO' ? toCents(line.amount) : 0),
    0
  );
  const missingCents = Math.max(0, totalCents - sumCents);
  const changeCents = Math.max(0, sumCents - totalCents);
  const base: PaymentResolution = { applied: [], sumCents, missingCents, changeCents, error: null };

  if (lines.length === 0) return { ...base, error: 'Adicione ao menos uma forma de pagamento.' };
  if (lines.some((line) => toCents(line.amount) <= 0)) {
    return { ...base, error: 'Informe o valor de cada forma de pagamento ou remova a linha vazia.' };
  }
  if (missingCents > 0) {
    return { ...base, error: `Faltam ${currency.format(missingCents / 100)} para completar o total.` };
  }
  if (changeCents > 0 && changeCents >= cashCents) {
    return { ...base, error: 'O valor acima do total só pode ser devolvido como troco de pagamento em dinheiro.' };
  }

  let pendingChange = changeCents;
  const applied = [...lines]
    .reverse()
    .map((line) => {
      let cents = toCents(line.amount);
      if (line.paymentMethod === 'DINHEIRO' && pendingChange > 0) {
        const deducted = Math.min(cents, pendingChange);
        cents -= deducted;
        pendingChange -= deducted;
      }
      return { ...line, amount: cents / 100 };
    })
    .reverse()
    .filter((line) => line.amount > 0);
  return { ...base, applied };
}

// Linhas de cartao com "Repassar taxa": juros calculados para o servidor conferir.
function withCardSurcharge(lines: PaymentLine[], table: CardFeeTable | null): PaymentLine[] {
  return lines.map((line) => (line.passFee ? { ...line, surcharge: lineSurcharge(table, line) } : line));
}

function surchargeTotal(lines: PaymentLine[]): number {
  return lines.reduce((sum, line) => sum + toCents(line.surcharge ?? 0), 0) / 100;
}

const percentText = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

function legacyPaymentMethod(applied: PaymentLine[]): string {
  return applied.length === 1 ? applied[0].paymentMethod : 'DIVIDIDO';
}

// Valores em reais calculados a partir de centavos para nao acumular erro de ponto flutuante.
function reservationAmounts(reservation: PosReservation): { total: number; remaining: number } {
  const totalCents = reservation.items.reduce((sum, item) => sum + toCents(item.lineTotal), 0);
  const remainingCents = Math.max(0, totalCents - toCents(reservation.depositAmount));
  return { total: totalCents / 100, remaining: remainingCents / 100 };
}

function valueAsNumber(value: string): number {
  return Number(value.replace(',', '.')) || 0;
}

function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}

// Aviso quando o serial bipado existe mas nao pode ser vendido aqui.
const SCANNED_SERIAL_MESSAGES: Record<string, string> = {
  VENDIDO: 'já foi vendida',
  RESERVADO: 'está reservada para um cliente (finalize pela tela de reservas)',
  PERDIDO: 'está marcada como perdida no estoque',
  OUTRA_LOJA: 'pertence ao estoque de outra loja',
};

function warrantyLabel(months: number | null): string {
  if (months === null) return 'Garantia nao cadastrada';
  if (months <= 0) return 'Sem garantia';
  return `${months} ${months === 1 ? 'mes' : 'meses'} de garantia`;
}

function discountedLineTotal(item: CartItem): number {
  return Math.round((item.sellPrice * item.quantity * (100 - item.discountPercent) / 100 + Number.EPSILON) * 100) / 100;
}

function localDateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function reservationDeadlineIso(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [terminal, setTerminal] = useState<TerminalContext | null>(null);
  const [cashSession, setCashSession] = useState<CashSession | null>(null);
  const [activationCode, setActivationCode] = useState<string>('');
  const [terminalName, setTerminalName] = useState('Caixa 01');
  const [password, setPassword] = useState('');
  // Senha Gerente digitada na sangria, no cancelamento de reserva com sinal e na gaveta.
  const [managerPassword, setManagerPassword] = useState('');
  // Janela da senha Gerente para acoes do menu (gaveta, Configuracoes).
  const [managerPrompt, setManagerPrompt] = useState<{ action: ManagerAction; title: string; confirm: string; onAuthorized: () => void } | null>(null);
  const [cashNumber, setCashNumber] = useState('Caixa 01');
  const [responsibleName, setResponsibleName] = useState('');
  const [openingFloat, setOpeningFloat] = useState('');
  const [movementType, setMovementType] = useState<MovementType>('SANGRIA');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [closure, setClosure] = useState<CashClosureSummary | null>(null);
  const [closingReport, setClosingReport] = useState<CashSessionReport | null>(null);
  const [counts, setCounts] = useState<CashCounts>(emptyCounts);
  const [closureNotes, setClosureNotes] = useState('');
  const [query, setQuery] = useState('');
  const [catalogItems, setCatalogItems] = useState<PosCatalogItem[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [reservations, setReservations] = useState<PosReservation[]>([]);
  const [reservationsLoading, setReservationsLoading] = useState(false);
  const [conversionReservation, setConversionReservation] = useState<PosReservation | null>(null);
  const [conversionPaymentLines, setConversionPaymentLines] = useState<PaymentLine[]>([]);
  // Cancelamento de reserva com sinal: pergunta como o sinal foi devolvido ao cliente.
  const [cancelTarget, setCancelTarget] = useState<PosReservation | null>(null);
  const [reservationCustomerName, setReservationCustomerName] = useState('');
  const [reservationCustomerPhone, setReservationCustomerPhone] = useState('');
  const [reservationCustomerCpf, setReservationCustomerCpf] = useState('');
  const [storeProfile, setStoreProfile] = useState<PosStoreProfile | null>(null);
  // Taxas do cartao da loja (ERP > Livro Caixa): parcelas e "Repassar taxa".
  const [cardFees, setCardFees] = useState<CardFeeTable | null>(null);
  // Cliente da venda (opcional): identifica a compra para nota e garantia.
  const [saleCustomer, setSaleCustomer] = useState<PosCustomer | null>(null);
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [customerForm, setCustomerForm] = useState<{ customer: PosCustomer | null; cpf: string } | null>(null);
  // Entrega de encomenda com serial: unidade escolhida por linha da reserva.
  const [conversionUnitChoices, setConversionUnitChoices] = useState<Record<string, string>>({});
  const [conversionUnitOptions, setConversionUnitOptions] = useState<Record<string, PosSerialUnit[]>>({});
  const [reservationExpiresOn, setReservationExpiresOn] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return localDateInputValue(date);
  });
  const [reservationDeposit, setReservationDeposit] = useState('');
  const [serialProduct, setSerialProduct] = useState<PosCatalogItem | null>(null);
  const [serialUnits, setSerialUnits] = useState<PosSerialUnit[]>([]);
  const [selectedSerialUnitId, setSelectedSerialUnitId] = useState<string | null>(null);
  const [serialUnitsLoading, setSerialUnitsLoading] = useState(false);
  const [serialUnitsError, setSerialUnitsError] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('DINHEIRO');
  const [paymentLines, setPaymentLines] = useState<PaymentLine[]>([]);
  const [adminApprovalOpen, setAdminApprovalOpen] = useState(false);
  const [adminApprovalPassword, setAdminApprovalPassword] = useState('');
  const [adminApprovalError, setAdminApprovalError] = useState<string | null>(null);
  // Codigo do vendedor (obrigatorio): venda, nova reserva e conversao de reserva.
  const [saleSellerCode, setSaleSellerCode] = useState('');
  const [tradeSellerCode, setTradeSellerCode] = useState('');
  const [tradeSeller, setTradeSeller] = useState<PosSeller | null>(null);
  const [tradeInKey, setTradeInKey] = useState(0);
  // Ordem de Servico: vendedor da tela, OS a reabrir e cobranca em andamento na venda.
  const [workOrderSellerCode, setWorkOrderSellerCode] = useState('');
  const [workOrderSeller, setWorkOrderSeller] = useState<PosSeller | null>(null);
  const [workOrdersKey, setWorkOrdersKey] = useState(0);
  const [workOrderFocus, setWorkOrderFocus] = useState<string | null>(null);
  const [workOrderCharge, setWorkOrderCharge] = useState<WorkOrderCharge | null>(null);
  const [saleSeller, setSaleSeller] = useState<PosSeller | null>(null);
  const [reservationSellerCode, setReservationSellerCode] = useState('');
  const [reservationSeller, setReservationSeller] = useState<PosSeller | null>(null);
  const [conversionSellerCode, setConversionSellerCode] = useState('');
  const [conversionSeller, setConversionSeller] = useState<PosSeller | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Venda em andamento guardada enquanto o vendedor monta uma reserva na tela de Reservas.
  const saleDraftRef = useRef<{ cart: CartItem[]; customer: PosCustomer | null; lines: PaymentLine[] } | null>(null);
  const reservationMode = screen === 'new-reservation';
  // NFC-e (2.8b): loja configurada no UCP? Escolha do vendedor (NFC-e / Nao Fiscal) da venda em curso.
  const [nfceConfig, setNfceConfig] = useState<PosNfceStatus | null>(null);
  const [nfceEmitting, setNfceEmitting] = useState(false);
  const [nfceProblem, setNfceProblem] = useState<{ saleId: string; change: number; status: NfceStatus; message: string | null } | null>(null);
  const fiscalChoiceRef = useRef<FiscalChoice>('NAO_FISCAL');
  // Troca/devolucao (2.9): venda aberta no modal e saldo de vale-troca do cliente da venda.
  const [returnSaleId, setReturnSaleId] = useState<string | null>(null);
  const [customerCredit, setCustomerCredit] = useState(0);
  // Modo offline: cliente digitado sem internet (CPF + nome).
  const [offlineCustomerOpen, setOfflineCustomerOpen] = useState(false);
  // Menu inicial (2.10): consulta de produto, versao do app e numero da abertura na barra.
  const [lookupOpen, setLookupOpen] = useState(false);
  // Impressao direta (2.8c): impressora termica escolhida neste PC.
  const [printerOpen, setPrinterOpen] = useState(false);
  const [directPrinter, setDirectPrinterState] = useState<string | null>(() => getDirectPrinter());
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [sessionNumber, setSessionNumber] = useState<number | null>(null);
  const offlineInfo = useOfflineState();
  const offlineNow = offlineInfo.offline;

  async function routeAfterUnlock() {
    const openCash = await getOpenCashSession();
    setCashSession(openCash);
    setScreen(openCash ? 'menu' : 'cash-open');
  }

  useEffect(() => {
    const { data: listener } = terminalAuth.watchSession();
    void (async () => {
      try {
        await terminalAuth.ensureAnonymousSession();
        const context = await getTerminalContext();
        if (!context) {
          setScreen('activation');
          return;
        }
        setTerminal(context);
        setCashNumber(context.displayName);
        void cacheTerminal(context);
        await routeToUnlock(context.needsAdminPassword);
      } catch (error) {
        // Sem internet: nunca voltar para a ativacao; usa o terminal guardado e o modo offline.
        const cached = isNetworkError(error) ? await getCachedTerminal() : null;
        if (cached) {
          setOffline(true);
          setTerminal(cached);
          setCashNumber(cached.displayName);
          setMessage('Sem internet: desbloqueie com a senha Gerente para vender no modo offline.');
          setScreen('unlock');
          return;
        }
        setMessage(isNetworkError(error) ? 'Sem internet. Conecte o computador à internet para ativar o PDV.' : errorMessage(error));
        setScreen(isNetworkError(error) ? 'loading' : 'activation');
      }
    })();
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (screen === 'sale') {
      searchInputRef.current?.focus();
    }
  }, [screen]);

  async function handleActivation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const context = await activateTerminal(activationCode, terminalName);
      setTerminal(context);
      setCashNumber(context.displayName);
      setActivationCode('');
      await routeToUnlock(true);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  // Senha Gerente da loja (ERP). Sem ela e sem a senha antiga do terminal: aviso para cadastrar.
  async function routeToUnlock(terminalWithoutPassword: boolean) {
    try {
      const status = await getManagerPasswordStatus();
      void syncManagerPasswordVersion(status.setAt);
      setScreen(status.configured || status.terminalHasAdmin ? 'unlock' : 'set-password');
    } catch {
      setScreen(terminalWithoutPassword ? 'set-password' : 'unlock');
    }
  }

  async function recheckManagerPassword() {
    setBusy(true);
    setMessage(null);
    try {
      const status = await getManagerPasswordStatus();
      if (!status.configured && !status.terminalHasAdmin) {
        setMessage('A senha Gerente ainda não foi cadastrada para esta loja.');
        return;
      }
      void syncManagerPasswordVersion(status.setAt);
      setScreen('unlock');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  // Confere a senha Gerente para uma acao. Devolve o erro para mostrar, ou null se liberou.
  // Sem internet (so gaveta e sangria): confere a copia local da senha.
  async function authorizeAction(action: ManagerAction, value: string, allowOffline: boolean): Promise<string | null> {
    if (!value) return 'Digite a senha Gerente.';
    const offlineCheck = async () => ((await verifyAdminPasswordOffline(value))
      ? null
      : 'Senha incorreta (sem internet, vale a senha do último desbloqueio feito com internet).');
    if (isOffline()) return allowOffline ? offlineCheck() : 'Sem internet esta ação não pode ser liberada.';
    try {
      const result = await authorizeManager(value, action);
      if (result.status === 'OK') return null;
      if (result.status === 'LOCKED') return passwordLockedMessage(result.lockedUntil);
      return result.remainingAttempts > 0
        ? `Senha Gerente incorreta. Restam ${result.remainingAttempts} tentativa(s).`
        : 'Senha Gerente incorreta. O terminal foi bloqueado temporariamente para senha.';
    } catch (error) {
      if (allowOffline && isNetworkError(error)) {
        setOffline(true);
        return offlineCheck();
      }
      return errorMessage(error);
    }
  }

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (isOffline()) {
        await unlockOffline();
        return;
      }
      const context = await requireAdminPassword(password);
      setTerminal(context);
      void cacheTerminal(context);
      void rememberAdminPassword(password);
      setPassword('');
      await routeAfterUnlock();
      void refreshSnapshot();
    } catch (error) {
      if (isNetworkError(error)) {
        setOffline(true);
        await unlockOffline();
        return;
      }
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  // Desbloqueio sem internet: confere a senha com o hash guardado no ultimo desbloqueio online.
  async function unlockOffline() {
    if (!(await verifyAdminPasswordOffline(password))) {
      setMessage('Senha incorreta (sem internet, vale a senha do último desbloqueio feito com internet).');
      return;
    }
    setPassword('');
    const snapshot = await getSnapshot();
    if (!snapshot?.cash) {
      setMessage('Sem internet e sem caixa aberto guardado: abra o caixa quando a internet voltar.');
      setScreen('unlock');
      return;
    }
    setCashSession(snapshot.cash);
    setScreen('menu');
    setMessage('MODO OFFLINE: vendas ficam guardadas neste computador e são enviadas quando a internet voltar.');
  }

  async function handleCashOpen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const opened = await openCashSession(cashNumber, responsibleName, valueAsNumber(openingFloat));
      setCashSession(opened);
      setScreen('menu');
      void printCashReport({
        subtitle: 'Abertura de PDV',
        date: new Date(opened.openedAt),
        cashNumber: opened.cashNumber,
        operator: opened.openedByName,
        cashAmount: opened.openingFloatAmount,
      });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const operator = responsibleName.trim() || cashSession?.openedByName || '';
      const denied = await authorizeAction(movementType === 'SANGRIA' ? 'CASH_WITHDRAWAL' : 'CASH_SUPPLY', managerPassword, true);
      if (denied) {
        setMessage(denied);
        setManagerPassword('');
        return;
      }
      setManagerPassword('');
      if (isOffline()) {
        await enqueueOfflineMovement({ type: movementType, amount: valueAsNumber(movementAmount), reason: movementReason, operatorName: operator });
      } else {
        await recordCashMovement(
          movementType,
          valueAsNumber(movementAmount),
          movementReason,
          operator
        );
      }
      void printCashReport({
        subtitle: movementType === 'SANGRIA' ? 'Sangria' : 'Suprimento',
        date: new Date(),
        cashNumber: cashSession?.cashNumber ?? '',
        operator,
        cashAmount: valueAsNumber(movementAmount),
        reason: movementReason.trim() || null,
      });
      setMovementAmount('');
      setMovementReason('');
      setScreen('menu');
      setMessage(`${movementType === 'SANGRIA' ? 'Sangria' : 'Suprimento'} registrado com sucesso.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function openClosing() {
    setBusy(true);
    setMessage(null);
    try {
      const summary = await getCashClosureSummary();
      setClosure(summary);
      // Dados extras do relatorio de fechamento; se a consulta falhar, o relatorio sai sem eles.
      setClosingReport(await getCashSessionReport().catch(() => null));
      // Contagem comeca no valor esperado, nunca negativa (o banco recusa contagem negativa).
      setCounts({
        cash: Math.max(0, summary.expectedCashAmount),
        pix: Math.max(0, summary.expectedPixAmount),
        credit: Math.max(0, summary.expectedCreditAmount),
        debit: Math.max(0, summary.expectedDebitAmount),
        voucher: Math.max(0, summary.expectedVoucherAmount),
        creditAccount: Math.max(0, summary.expectedCreditAccountAmount),
      });
      setPassword('');
      setScreen('cash-close');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCashClose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const denied = await authorizeAction('CASH_CLOSE', password, false);
      if (denied) {
        setMessage(denied);
        setPassword('');
        return;
      }
      await closeCashSession(responsibleName, counts, closureNotes);
      if (closure) {
        const closingData = { summary: closure, report: closingReport, counts, closedBy: responsibleName.trim(), closedAt: new Date() };
        void loadStoreProfile()
          .then((store) => printClosingReport(closingData, store))
          .catch((error) => setMessage(`Caixa fechado, mas o relatório não pôde ser impresso: ${errorMessage(error)}`));
      }
      setClosingReport(null);
      setCashSession(null);
      setClosure(null);
      setPassword('');
      setClosureNotes('');
      setScreen('cash-open');
      setMessage('Caixa fechado com sucesso. Abra um novo caixa para voltar a vender.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setCatalogItems([]);
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      let found: PosCatalogItem[];
      if (isOffline()) {
        found = await searchOffline(trimmedQuery);
      } else {
        try {
          found = await searchPosItems(trimmedQuery);
        } catch (searchError) {
          if (!isNetworkError(searchError)) throw searchError;
          setOffline(true);
          found = await searchOffline(trimmedQuery);
        }
      }
      const normalizedQuery = normalizeSku(trimmedQuery);
      const exactSkuMatches = found.filter((item) => normalizeSku(item.sku) === normalizedQuery);

      // Codigo exato com estoque: direto no carrinho. Sem estoque: mostra o card ("Sem estoque").
      const exactMatch = exactSkuMatches.length === 1 ? exactSkuMatches[0] : null;
      if (exactMatch && !(exactMatch.itemType === 'PRODUCT' && exactMatch.availableQuantity <= 0)) {
        await selectProduct(exactMatch);
        return;
      }

      if (exactSkuMatches.length > 1) {
        setMessage(
          `Foram encontrados ${exactSkuMatches.length} itens com o código "${trimmedQuery}". Selecione manualmente na lista para evitar ambiguidade.`
        );
      }

      // Nao e codigo de produto: pode ser o serial (ou IMEI) de uma unidade bipada.
      if (exactSkuMatches.length === 0 && !/\s/.test(trimmedQuery)) {
        // Falha nesta consulta extra nao pode impedir a busca normal por nome.
        if (isOffline()) {
          const local = await findOfflineSerial(trimmedQuery);
          if (local) {
            addSerialUnitToCart(local.product, local.unit);
            return;
          }
        }
        const scanned = isOffline() ? null : await findPosSerialUnit(trimmedQuery).catch(() => null);
        if (scanned) {
          if (scanned.serialUnit) {
            addSerialUnitToCart(scanned.product, scanned.serialUnit);
          } else {
            setMessage(`A unidade ${scanned.serialNumber} (${scanned.product.name}) ${SCANNED_SERIAL_MESSAGES[scanned.status] ?? 'não está disponível para venda'}.`);
            setCatalogItems([]);
          }
          return;
        }
      }

      setCatalogItems(found);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectProduct(product: PosCatalogItem) {
    if (reservationMode && product.itemType === 'SERVICE') {
      setMessage('Serviços não podem ser reservados: adicione o serviço na hora da venda.');
      return;
    }
    // Sem estoque nesta loja: na reserva entra como encomenda; na venda, orienta a reservar.
    if (product.itemType === 'PRODUCT' && product.availableQuantity <= 0) {
      if (!reservationMode) {
        setMessage(`"${product.name}" está sem estoque nesta loja. Para encomendar, use Reservas > Nova reserva.`);
        return;
      }
      addBackorder(product);
      setCatalogItems([]);
      setQuery('');
      setMessage(`"${product.name}" está sem estoque nesta loja: entrou como encomenda.`);
      return;
    }
    if (product.itemType === 'PRODUCT' && product.requiresUnitSelection) {
      if (!terminal) {
        setMessage('O terminal precisa estar ativado para consultar unidades serializadas.');
        return;
      }
      setSerialProduct(product);
      setSerialUnits([]);
      setSelectedSerialUnitId(null);
      setSerialUnitsError(null);
      setSerialUnitsLoading(true);
      try {
        const availableUnits = isOffline()
          ? await offlineSerialUnits(product.id)
          : await getPosAvailableSerialUnits(product.id, terminal.unitId);
        setSerialUnits(availableUnits);
      } catch (error) {
        setSerialUnitsError(errorMessage(error));
      } finally {
        setSerialUnitsLoading(false);
      }
      return;
    }

    addProduct(product);
    setCatalogItems([]);
    setQuery('');
    setMessage(`${product.itemType === 'SERVICE' ? 'Serviço' : 'Produto'} "${product.name}" adicionado ${reservationMode ? 'à reserva' : 'ao carrinho'}.`);
  }

  function addProduct(product: PosCatalogItem) {
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id && item.itemType === product.itemType && !item.serialUnit && !item.backorder && !item.workOrderId);
      if (!existing) return [...current, { ...product, quantity: 1, discountPercent: 0 }];

      if (product.itemType === 'PRODUCT' && existing.quantity >= product.availableQuantity) {
        setMessage('Quantidade maxima disponivel no estoque atingida.');
        return current;
      }

      return current.map((item) =>
        item === existing ? { ...item, quantity: item.quantity + 1 } : item
      );
    });
  }

  function addBackorder(product: PosCatalogItem) {
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id && item.backorder);
      if (!existing) return [...current, { ...product, quantity: 1, discountPercent: 0, backorder: true }];
      return current.map((item) => (item === existing ? { ...item, quantity: item.quantity + 1 } : item));
    });
  }

  function changeQuantity(productId: string, itemType: PosCatalogItem['itemType'], change: number) {
    setCart((current) =>
      current.flatMap((item) => {
        if (item.id !== productId || item.itemType !== itemType || item.workOrderId) return [item];
        const quantity = item.quantity + change;
        if (quantity <= 0) return [];
        return item.itemType === 'PRODUCT' && !item.backorder && quantity > item.availableQuantity ? [item] : [{ ...item, quantity }];
      })
    );
  }

  function updateItemDiscount(itemId: string, itemType: PosCatalogItem['itemType'], value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    setMessage(null);
    setCart((current) => current.map((item) =>
      item.id === itemId && item.itemType === itemType ? { ...item, discountPercent: value } : item
    ));
  }

  function closeSerialUnitModal() {
    if (serialUnitsLoading) return;
    setSerialProduct(null);
    setSerialUnits([]);
    setSelectedSerialUnitId(null);
    setSerialUnitsError(null);
  }

  function addSerialUnitToCart(product: PosCatalogItem, serialUnit: PosSerialUnit) {
    const alreadyInCart = cart.some((item) => item.serialUnit?.serialUnitId === serialUnit.serialUnitId);
    if (!alreadyInCart) {
      setCart((current) => current.some((item) => item.serialUnit?.serialUnitId === serialUnit.serialUnitId)
        ? current
        : [...current, { ...product, quantity: 1, discountPercent: 0, serialUnit }]);
    }
    setCatalogItems([]);
    setQuery('');
    setMessage(alreadyInCart
      ? 'Esta unidade serializada ja esta no carrinho.'
      : `Unidade ${serialUnit.serialNumber} adicionada ao carrinho.`);
  }

  function addSelectedSerialUnit() {
    if (!serialProduct || !selectedSerialUnitId) return;
    const serialUnit = serialUnits.find((unit) => unit.serialUnitId === selectedSerialUnitId);
    if (!serialUnit) return;

    addSerialUnitToCart(serialProduct, serialUnit);
    closeSerialUnitModal();
  }

  // Limite de cada item (produto; sem limite proprio, o padrao da loja). 0% = nenhum
  // desconto sem senha (mesma regra do servidor).
  function cartHasOverLimitDiscount(): boolean {
    return cart.some((item) => item.discountPercent > item.maxItemDiscountPercent);
  }

  async function finalizeSale(fiscal?: FiscalChoice) {
    if (fiscal) fiscalChoiceRef.current = fiscal;
    if (!cashSession || cart.length === 0) return;
    if (cart.some((item) => item.backorder)) {
      setMessage('Itens de encomenda (sem estoque) só podem ser reservados.');
      return;
    }
    if (!saleSeller) {
      setMessage('Informe o código do vendedor para finalizar a venda.');
      return;
    }
    if (isOffline() && cart.some((item) => item.workOrderId)) {
      setMessage('Sem internet não dá para cobrar a ordem de serviço. Aguarde a conexão voltar.');
      return;
    }
    const resolution = resolvePayments(paymentLines, grossAmount);
    if (resolution.error) {
      setMessage(resolution.error);
      return;
    }
    const needsApproval = cartHasOverLimitDiscount();
    if (needsApproval && isOffline()) {
      setMessage('Sem internet não dá para liberar desconto acima do limite (a senha é conferida no servidor). Ajuste o desconto.');
      return;
    }
    if (needsApproval && !adminApprovalOpen) {
      setAdminApprovalPassword('');
      setAdminApprovalError(null);
      setAdminApprovalOpen(true);
      return;
    }
    const charged = withCardSurcharge(resolution.applied, cardFees);
    const juros = surchargeTotal(charged);
    if (juros > 0 && isOffline()) {
      setMessage('Sem internet não dá para repassar a taxa do cartão. Desligue "Repassar taxa" e cobre na maquininha sem juros.');
      return;
    }
    setBusy(true);
    setMessage(null);
    setAdminApprovalError(null);
    const saleId = crypto.randomUUID();
    if (isOffline()) {
      try {
        await finalizeOffline(saleId, resolution.applied, resolution.changeCents / 100);
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const result = await saleRpc.processTransaction({
        saleId,
        invoiceNumber: `PDV-${Date.now()}`,
        items: cart.map((item) => ({
          itemType: item.itemType,
          ...(item.itemType === 'SERVICE' ? { serviceId: item.id } : { productId: item.id }),
          itemSku: item.sku,
          itemName: item.name,
          quantity: item.quantity,
          discountPercent: item.discountPercent,
          unitPrice: item.sellPrice,
          lineTotal: discountedLineTotal(item),
          ...(item.serialUnit
            ? {
                serials: [item.serialUnit.serialNumber],
              }
            : {}),
          ...(item.workOrderId ? { workOrderId: item.workOrderId } : {}),
        })),
        paymentMethod: legacyPaymentMethod(resolution.applied),
        payments: charged,
        grossAmount,
        feeAmount: 0,
        netAmount: grossAmount,
        clientCpf: saleCustomer?.cpf ?? null,
        clientName: saleCustomer?.name ?? null,
        timestamp: new Date().toISOString(),
        status: 'CONCLUIDA',
        requiresApproval: false,
        adminPassword: needsApproval ? adminApprovalPassword : null,
        sellerCode: saleSeller.code,
      });
      if (result.status === 'INVALID_SELLER') {
        const text = 'Código de vendedor inválido para esta loja. Confira o código e tente de novo.';
        setSaleSeller(null);
        setMessage(text);
        if (adminApprovalOpen) setAdminApprovalError(text);
        return;
      }
      if (result.status === 'INVALID_PASSWORD') {
        setAdminApprovalPassword('');
        setAdminApprovalError(
          result.remainingAttempts > 0
            ? `Senha Gerente incorreta. Restam ${result.remainingAttempts} tentativa(s) antes do bloqueio temporário.`
            : 'Senha Gerente incorreta. O terminal foi bloqueado temporariamente para senha.'
        );
        return;
      }
      if (result.status === 'LOCKED') {
        setAdminApprovalPassword('');
        setAdminApprovalError(passwordLockedMessage(result.lockedUntil));
        return;
      }
      const charge = cart.some((item) => item.workOrderId) ? workOrderCharge : null;
      const sellerCode = saleSeller.code;
      setCart([]);
      setCatalogItems([]);
      setQuery('');
      setPaymentLines([]);
      setSaleSellerCode('');
      setSaleSeller(null);
      setSaleCustomer(null);
      setAdminApprovalPassword('');
      setAdminApprovalOpen(false);
      setWorkOrderCharge(null);
      setMessage(
        (resolution.changeCents > 0
          ? `Venda registrada com sucesso. Troco: ${currency.format(resolution.changeCents / 100)}.`
          : 'Venda registrada com sucesso.')
          + (juros > 0 ? ` Total com juros do cartão: ${currency.format(grossAmount + juros)}.` : '')
      );
      void deliverReceipt(saleId, resolution.changeCents / 100);
      if (charge) void finishWorkOrderSale(charge, sellerCode, resolution.changeCents / 100);
      // Venda com dinheiro: abre a gaveta (impressao direta configurada).
      if (resolution.applied.some((line) => line.paymentMethod === 'DINHEIRO')) void openCashDrawer();
    } catch (error) {
      // Caiu a internet no meio: registra offline com o mesmo id (o envio e idempotente).
      if (isNetworkError(error)) {
        setOffline(true);
        if (juros > 0) {
          setMessage('A internet caiu. Sem internet não dá para repassar a taxa do cartão: desligue "Repassar taxa" e finalize de novo.');
          return;
        }
        await finalizeOffline(saleId, resolution.applied, resolution.changeCents / 100);
        return;
      }
      const text = errorMessage(error);
      setMessage(text);
      if (adminApprovalOpen) setAdminApprovalError(text);
      // Taxa alterada no ERP durante o dia: recarrega para o vendedor conferir.
      getPosCardFees().then(setCardFees).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  // Venda sem internet: guarda na fila, desconta da copia local e imprime o cupom.
  // NFC-e pelo Comunicador Offline (contingencia); se nao der, sai como Nao Fiscal.
  async function finalizeOffline(saleId: string, applied: PaymentLine[], changeAmount: number) {
    const snapshot = await getSnapshot();
    if (!snapshot?.cash || !saleSeller) {
      setMessage('Sem internet e sem os dados do caixa guardados: não é possível vender offline.');
      return;
    }
    if (applied.some((line) => line.paymentMethod === 'VOUCHER')) {
      setMessage('Vale-troca não pode ser usado sem internet (o saldo é conferido no servidor).');
      return;
    }
    const items: OfflineSaleItem[] = cart.map((item) => ({
      itemType: item.itemType,
      ...(item.itemType === 'SERVICE' ? { serviceId: item.id } : { productId: item.id }),
      itemSku: item.sku,
      itemName: item.name,
      quantity: item.quantity,
      discountPercent: item.discountPercent,
      unitPrice: item.sellPrice,
      lineTotal: discountedLineTotal(item),
      ...(item.serialUnit ? { serials: [item.serialUnit.serialNumber] } : {}),
    }));
    const timestamp = new Date().toISOString();
    const payload: OfflineSalePayload = {
      saleId,
      invoiceNumber: `PDV-${Date.now()}`,
      timestamp,
      cashSessionId: snapshot.cash.id,
      sellerCode: saleSeller.code,
      sellerName: saleSeller.name,
      clientCpf: saleCustomer?.cpf ?? null,
      clientName: saleCustomer?.name ?? null,
      items,
      payments: applied.map((line) => ({ paymentMethod: line.paymentMethod, amount: Number(line.amount.toFixed(2)) })),
      nfce: null,
    };
    let fiscalNote = '';
    if (fiscalChoiceRef.current === 'NFCE') {
      const oldest = await oldestPendingAt();
      if (oldest && Date.now() - oldest.getTime() > 24 * 60 * 60 * 1000) {
        fiscalNote = ' NFC-e não emitida: há vendas sem internet há mais de 24 horas (prazo da contingência). Saiu como Não Fiscal.';
      } else if (!snapshot.nfce?.configured) {
        fiscalNote = ' NFC-e não configurada para esta loja: saiu como Não Fiscal.';
      } else {
        const local = await emitLocalNfce(payload, snapshot);
        if (local.ok) payload.nfce = local.nfce;
        else fiscalNote = ` NFC-e não emitida (${local.message}). Saiu como Não Fiscal.`;
      }
    }
    await enqueueOfflineSale(payload);
    const receipt: PosSaleReceipt = {
      saleId,
      receiptNumber: null,
      timestamp,
      items: items.map((item) => ({
        itemType: item.itemType, itemSku: item.itemSku, itemName: item.itemName, quantity: item.quantity,
        unitPrice: item.unitPrice, discountPercent: item.discountPercent, lineTotal: item.lineTotal, serials: item.serials ?? [],
      })),
      grossAmount,
      depositApplied: 0,
      paymentMethod: applied.length === 1 ? applied[0].paymentMethod : 'DIVIDIDO',
      payments: payload.payments,
      sellerName: saleSeller.name,
      clientName: payload.clientName,
      clientCpf: payload.clientCpf,
      fiscalStatus: payload.nfce ? 'AUTORIZADA' : null,
      nfce: payload.nfce
        ? {
            environment: (payload.nfce.environment as 'homologacao' | 'producao') ?? null,
            number: (payload.nfce.number as string | null) ?? null,
            series: (payload.nfce.series as string | null) ?? null,
            key: (payload.nfce.key as string | null) ?? null,
            protocol: (payload.nfce.protocol as string | null) ?? null,
            qrcodeUrl: (payload.nfce.qrcodeUrl as string | null) ?? null,
            consultUrl: (payload.nfce.consultUrl as string | null) ?? null,
            authorizedAt: timestamp,
            taxTotal: Number(payload.nfce.taxTotal ?? 0),
            message: null,
            contingency: true,
            contingencyDone: false,
          }
        : null,
    };
    await saveLastOfflineReceipt({ receipt, changeAmount });
    void printSaleReceipt(receipt, snapshot.store, changeAmount);
    if (applied.some((line) => line.paymentMethod === 'DINHEIRO')) void openCashDrawer();
    setCart([]);
    setCatalogItems([]);
    setQuery('');
    setPaymentLines([]);
    setSaleSellerCode('');
    setSaleSeller(null);
    setSaleCustomer(null);
    setMessage(`Venda registrada SEM INTERNET${changeAmount > 0 ? ` (troco: ${currency.format(changeAmount)})` : ''}. Ela será enviada automaticamente quando a conexão voltar.${fiscalNote}`);
  }

  function configureComunicador() {
    const port = window.prompt('Porta do Comunicador Offline da Focus neste computador (em branco = desligado):', getComunicadorPort() ?? '');
    if (port === null) return;
    const clean = port.replace(/\D/g, '');
    setComunicadorPort(clean || null);
    setMessage(clean ? `Comunicador Offline configurado na porta ${clean}.` : 'Comunicador Offline desligado neste computador.');
  }

  // Caixa parcial: relatorio do caixa ainda aberto, sem contagem.
  async function printPartialReport() {
    setBusy(true);
    try {
      const summary = await getCashClosureSummary();
      const report = await getCashSessionReport().catch(() => null);
      await printClosingReport({
        summary,
        report,
        counts: {
          cash: summary.expectedCashAmount,
          pix: summary.expectedPixAmount,
          credit: summary.expectedCreditAmount,
          debit: summary.expectedDebitAmount,
          voucher: summary.expectedVoucherAmount,
          creditAccount: summary.expectedCreditAccountAmount,
        },
        closedBy: summary.openedByName,
        closedAt: new Date(),
        partial: true,
      }, await loadStoreProfile());
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function handleMenuAction(action: MenuAction) {
    setMessage(null);
    switch (action) {
      case 'sale': setScreen('sale'); break;
      case 'reservations': void openReservations(); break;
      case 'returns':
        setScreen('receipts');
        setMessage('Busque a venda (data, número ou CPF) e use "Trocar / Devolver".');
        break;
      case 'warranty': setScreen('warranty'); break;
      case 'trade-in':
        setTradeInKey((key) => key + 1);
        setTradeSellerCode('');
        setTradeSeller(null);
        setScreen('trade-in');
        break;
      case 'work-orders':
        openWorkOrders(null);
        break;
      case 'receipts':
        if (offlineNow) void reprintLastOfflineReceipt();
        else setScreen('receipts');
        break;
      case 'today-sales': setScreen('receipts'); break;
      case 'new-reservation': startNewReservation(); break;
      case 'sangria':
      case 'suprimento':
        setMovementType(action === 'sangria' ? 'SANGRIA' : 'SUPRIMENTO');
        setScreen('cash-movement');
        break;
      case 'partial': void printPartialReport(); break;
      case 'open-cash': setScreen('cash-open'); break;
      case 'close-cash':
        if (offlineNow || offlineInfo.pending > 0 || offlineInfo.errors > 0) {
          setMessage('Para fechar o caixa é preciso internet e todas as vendas feitas sem internet enviadas.');
          return;
        }
        void openClosing();
        break;
      case 'reprint-opening':
        if (cashSession) {
          void printCashReport({
            subtitle: 'Abertura de PDV',
            date: new Date(cashSession.openedAt),
            cashNumber: cashSession.cashNumber,
            operator: cashSession.openedByName,
            cashAmount: cashSession.openingFloatAmount,
          });
        }
        break;
      case 'lock':
        setPassword('');
        setScreen('unlock');
        break;
      case 'product-lookup': setLookupOpen(true); break;
      case 'comunicador': configureComunicador(); break;
      case 'version':
        setMessage(`Kanguru PDV versão ${appVersion ?? '-'}. O PDV procura atualizações sozinho ao abrir e a cada 4 horas.`);
        break;
      case 'printer': setPrinterOpen(true); break;
      case 'drawer':
        setManagerPassword('');
        setManagerPrompt({
          action: 'CASH_DRAWER',
          title: 'Abrir gaveta',
          confirm: 'Abrir gaveta',
          onAuthorized: () => void openCashDrawer().then((ok) => setMessage(ok ? 'Gaveta aberta.' : 'Não foi possível abrir a gaveta. Confira a impressora em Configurações › Impressora.')),
        });
        break;
      default:
        break;
    }
  }

  async function reprintLastOfflineReceipt() {
    const last = await getLastOfflineReceipt<{ receipt: PosSaleReceipt; changeAmount: number }>();
    if (!last) {
      setMessage('Nenhuma venda feita sem internet para reimprimir.');
      return;
    }
    void printSaleReceipt(last.receipt, (await getSnapshot())?.store ?? null, last.changeAmount);
  }

  async function confirmDiscountApproval() {
    if (!adminApprovalPassword) {
      setAdminApprovalError('Digite a senha Gerente para liberar o desconto.');
      return;
    }
    await finalizeSale();
  }

  async function loadStoreProfile(): Promise<PosStoreProfile | null> {
    if (storeProfile) return storeProfile;
    try {
      const profile = await getPosStoreProfile();
      setStoreProfile(profile);
      return profile;
    } catch {
      return null;
    }
  }

  // Cupom da venda. Sem saleId: ultima venda deste terminal (reimpressao).
  async function printReceipt(saleId: string | null, changeAmount = 0) {
    try {
      const receipt = await getPosSaleReceipt(saleId);
      if (!receipt) {
        setMessage('Nenhuma venda deste terminal para reimprimir.');
        return;
      }
      await printSaleReceipt(receipt, await loadStoreProfile(), changeAmount);
    } catch (error) {
      setMessage(`Venda registrada, mas o cupom não pôde ser impresso: ${errorMessage(error)}`);
    }
  }

  // Depois da venda: Nao Fiscal imprime o cupom; NFC-e emite a nota e imprime o DANFE.
  async function deliverReceipt(saleId: string, changeAmount: number) {
    if (fiscalChoiceRef.current === 'NFCE') await emitNfce(saleId, changeAmount);
    else await printReceipt(saleId, changeAmount);
  }

  async function emitNfce(saleId: string, changeAmount: number) {
    setNfceEmitting(true);
    setNfceProblem(null);
    try {
      const result = await emitPosNfce(saleId);
      if (result.status === 'AUTORIZADA') {
        const label = result.contingency
          ? 'NFC-e emitida em CONTINGÊNCIA (Sefaz fora do ar): entregue a via do consumidor e guarde a via do estabelecimento. A nota é enviada à Sefaz automaticamente.'
          : 'NFC-e autorizada.';
        setMessage(changeAmount > 0 ? `${label} Troco: ${currency.format(changeAmount)}.` : label);
        await printReceipt(saleId, changeAmount);
      } else {
        setNfceProblem({ saleId, change: changeAmount, status: result.status, message: result.message });
      }
    } finally {
      setNfceEmitting(false);
    }
  }

  // Relatorio Gerencial (abertura, sangria, suprimento): falha na impressao nao desfaz a operacao.
  async function printCashReport(report: ManagerialReport) {
    try {
      await printManagerialReport(report, await loadStoreProfile());
    } catch (error) {
      setMessage(`Operação registrada, mas o relatório não pôde ser impresso: ${errorMessage(error)}`);
    }
  }

  // Troca Gamer concluida: dinheiro abre a gaveta; "usar o vale agora" vai para a venda com o cliente.
  async function finishTradeIn(result: TradeInDone) {
    const { record } = result;
    const text = `Troca Gamer nº ${record.tradeNumber} registrada: ${currency.format(record.amount)}.`;
    if (!result.useVoucherNow) {
      setMessage(text);
      setScreen('menu');
      return;
    }
    const found = await searchPosCustomers(record.customerCpf).catch(() => []);
    const customer = found.find((item) => item.cpf === record.customerCpf);
    if (customer) setSaleCustomer(customer);
    setScreen('sale');
    setMessage(`${text} Escolha os produtos e clique em "Usar vale-troca" (${currency.format(record.amount)}).`);
  }

  function openWorkOrders(focusId: string | null) {
    setWorkOrdersKey((key) => key + 1);
    setWorkOrderSellerCode('');
    setWorkOrderSeller(null);
    setWorkOrderFocus(focusId);
    setScreen('work-orders');
  }

  // Cobrar a OS: venda normal com os servicos da OS no carrinho e o cliente preenchido.
  // Preco e limite de desconto atuais do cadastro (o servidor recalcula na venda).
  async function chargeWorkOrder(charge: WorkOrderCharge): Promise<string | null> {
    if (!cashSession) return 'Abra o caixa para cobrar a ordem de serviço.';
    if (cart.length > 0) return 'Há uma venda em andamento: finalize ou limpe o carrinho antes de cobrar a OS.';
    const { order } = charge;
    const items: CartItem[] = [];
    for (const service of order.items) {
      const found = (await searchPosItems(service.sku)).find((item) => item.itemType === 'SERVICE' && item.id === service.serviceId);
      if (!found) return `O serviço "${service.name}" está inativo ou foi excluído no ERP. Troque o serviço na OS.`;
      items.push({ ...found, quantity: 1, discountPercent: 0, workOrderId: order.workOrderId, workOrderNumber: order.orderNumber });
    }
    if (order.customerCpf) {
      const customers = await searchPosCustomers(order.customerCpf).catch(() => []);
      setSaleCustomer(customers.find((item) => item.cpf === order.customerCpf) ?? null);
    }
    setCart(items);
    setPaymentLines([]);
    setWorkOrderCharge(charge);
    setScreen('sale');
    setMessage(`Cobrança da OS nº ${order.orderNumber}${charge.deliver ? ' (entrega)' : ''}: escolha a forma de pagamento e finalize em "Não Fiscal".`);
    return null;
  }

  function cancelWorkOrderCharge() {
    const number = workOrderCharge?.order.orderNumber;
    setCart((current) => current.filter((item) => !item.workOrderId));
    setWorkOrderCharge(null);
    setMessage(number ? `Cobrança da OS nº ${number} cancelada. A OS continua a pagar.` : null);
  }

  // Depois da venda da OS: entrega registra e imprime o comprovante de entrega;
  // pagamento na abertura imprime o comprovante de entrada ja como "pago".
  async function finishWorkOrderSale(charge: WorkOrderCharge, sellerCode: string, changeAmount: number) {
    const { order } = charge;
    const change = changeAmount > 0 ? ` Troco: ${currency.format(changeAmount)}.` : '';
    try {
      if (charge.deliver) {
        const result = await deliverWorkOrder(order.workOrderId, sellerCode, { withoutRepair: false, tested: true });
        if (result.status !== 'OK') throw new Error(result.status === 'INVALID_SELLER' ? 'código do vendedor inválido' : 'OS não ficou paga');
        const record = result.order;
        setMessage(`OS nº ${order.orderNumber} paga e entregue.${change} Colha a assinatura do cliente no comprovante de entrega.`);
        await printWorkOrder(record, await loadStoreProfile(), 'delivery');
      } else {
        const record = await getWorkOrder(order.workOrderId);
        setMessage(`OS nº ${order.orderNumber} paga.${change} Colha a assinatura do cliente no comprovante de abertura.`);
        await printWorkOrder(record, await loadStoreProfile(), 'entry');
      }
    } catch (error) {
      setMessage(`Venda registrada, mas a OS nº ${order.orderNumber} não foi atualizada: ${errorMessage(error)}. Abra a OS em "Ordens de serviço" e conclua por lá.`);
    }
  }

  // Troca: volta para a venda com o cliente selecionado; o vale ja esta no CPF dele.
  async function finishReturn(result: ReturnDone) {
    setReturnSaleId(null);
    setMessage(result.message);
    if (!result.exchange) return;
    const found = await searchPosCustomers(result.exchange.cpf).catch(() => []);
    const customer = found.find((item) => item.cpf === result.exchange?.cpf);
    if (customer) setSaleCustomer(customer);
    setScreen('sale');
    setMessage(`${result.message} Escolha os produtos da troca e clique em "Usar vale-troca" (${currency.format(result.exchange.amount)}).`);
  }

  // Vale-troca como forma de pagamento (VOUCHER): cobre o que falta, ate o saldo do CPF.
  function applyCustomerCredit() {
    const others = paymentLines.filter((line) => line.paymentMethod !== 'VOUCHER');
    const othersTotal = others.reduce((sum, line) => sum + line.amount, 0);
    const amount = Math.round(Math.min(customerCredit, Math.max(0, grossAmount - othersTotal)) * 100) / 100;
    if (amount <= 0) {
      setMessage('As formas de pagamento já cobrem o total da venda.');
      return;
    }
    setPaymentLines([{ paymentMethod: 'VOUCHER', amount }, ...others]);
  }

  async function printVoucher(data: ReservationVoucherData) {
    printReservationVoucher(data, await loadStoreProfile());
  }

  function voucherFromReservation(reservation: PosReservation): ReservationVoucherData {
    return {
      reservationId: reservation.id,
      customerName: reservation.customerName,
      customerCpf: reservation.customerCpf,
      customerPhone: reservation.customerPhone,
      items: reservation.items.map((item) => ({
        name: item.itemName,
        quantity: item.quantity,
        serialNumber: item.serialNumber,
        isBackorder: item.isBackorder === true,
      })),
      total: reservation.items.reduce((sum, item) => sum + item.lineTotal, 0),
      depositAmount: reservation.depositAmount,
      depositPaymentMethod: reservation.depositPaymentMethod,
      createdAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
      sellerName: reservation.sellerName,
    };
  }

  async function openReservations() {
    setBusy(true);
    setReservationsLoading(true);
    setMessage(null);
    try {
      setReservations(await getPosReservations());
      setScreen('reservations');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setReservationsLoading(false);
      setBusy(false);
    }
  }

  function defaultReservationDate(): string {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return localDateInputValue(date);
  }

  function startNewReservation() {
    saleDraftRef.current = { cart, customer: saleCustomer, lines: paymentLines };
    setCart([]);
    setSaleCustomer(null);
    setPaymentLines([]);
    setCatalogItems([]);
    setQuery('');
    setMessage(null);
    setReservationCustomerName('');
    setReservationCustomerPhone('');
    setReservationCustomerCpf('');
    setReservationExpiresOn(defaultReservationDate());
    setReservationDeposit('');
    setReservationSellerCode('');
    setReservationSeller(null);
    setScreen('new-reservation');
  }

  function restoreSaleDraft() {
    const draft = saleDraftRef.current;
    saleDraftRef.current = null;
    setCart(draft?.cart ?? []);
    setSaleCustomer(draft?.customer ?? null);
    setPaymentLines(draft?.lines ?? []);
    setCatalogItems([]);
    setQuery('');
  }

  function leaveNewReservation() {
    restoreSaleDraft();
    void openReservations();
  }

  function fillReservationCustomer(customer: PosCustomer) {
    setReservationCustomerName(customer.name);
    setReservationCustomerCpf(maskCpf(customer.cpf));
    setReservationCustomerPhone(customer.phone);
  }

  async function submitReservation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cashSession || cart.length === 0 || cart.some((item) => item.itemType !== 'PRODUCT')) return;
    if (!reservationSeller) {
      setMessage('Informe o código do vendedor que está fazendo a reserva.');
      return;
    }
    if (!isValidCpf(reservationCustomerCpf)) {
      setMessage('Informe um CPF válido do cliente para registrar a reserva.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const depositAmount = valueAsNumber(reservationDeposit);
    const expiresAt = reservationDeadlineIso(reservationExpiresOn);
    try {
      const reservationId = await createPosReservation({
        customerName: reservationCustomerName.trim(),
        customerPhone: reservationCustomerPhone.trim(),
        customerCpf: reservationCustomerCpf.replace(/\D/g, ''),
        expiresAt,
        depositAmount,
        depositPaymentMethod: depositAmount > 0 ? paymentMethod : null,
        // Encomenda com serial: uma linha por unidade (o serial e escolhido na entrega).
        items: cart.flatMap((item): ReservationLineInput[] => item.backorder && item.requiresUnitSelection
          ? Array.from({ length: item.quantity }, () => ({
              productId: item.id,
              quantity: 1,
              discountPercent: item.discountPercent,
              backorder: true,
            }))
          : [{
              productId: item.id,
              quantity: item.quantity,
              discountPercent: item.discountPercent,
              ...(item.serialUnit ? { serialUnitId: item.serialUnit.serialUnitId } : {}),
              ...(item.backorder ? { backorder: true } : {}),
            }]),
        sellerCode: reservationSeller.code,
      });
      const voucher: ReservationVoucherData = {
        reservationId,
        customerName: reservationCustomerName.trim(),
        customerCpf: reservationCustomerCpf.replace(/\D/g, ''),
        customerPhone: reservationCustomerPhone.trim() || null,
        items: cart.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          serialNumber: item.serialUnit?.serialNumber ?? null,
          isBackorder: item.backorder === true,
        })),
        total: grossAmount,
        depositAmount,
        depositPaymentMethod: depositAmount > 0 ? paymentMethod : null,
        createdAt: new Date().toISOString(),
        expiresAt,
        sellerName: reservationSeller.name,
      };
      setReservationCustomerName('');
      setReservationCustomerPhone('');
      setReservationCustomerCpf('');
      setReservationDeposit('');
      setReservationSellerCode('');
      setReservationSeller(null);
      void printVoucher(voucher);
      restoreSaleDraft();
      setReservations(await getPosReservations().catch(() => reservations));
      setScreen('reservations');
      setMessage(`Reserva registrada para ${reservationSeller.name}. Imprima o voucher: a via de cima fica na loja e o canhoto vai para o cliente.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function convertReservationToSale(reservation: PosReservation, lines: PaymentLine[], fiscal: FiscalChoice) {
    fiscalChoiceRef.current = fiscal;
    if (!cashSession) return;
    const { total, remaining } = reservationAmounts(reservation);
    // Sinal cobrindo tudo: sem linhas de pagamento (cai no caminho legado, saldo zero).
    const resolution = remaining > 0 ? resolvePayments(lines, remaining) : null;
    if (resolution?.error) {
      setMessage(resolution.error);
      return;
    }
    if (!conversionSeller) {
      setMessage('Informe o seu código de vendedor para finalizar a conversão.');
      return;
    }
    const pendingUnits = reservation.items.filter((item) => item.isBackorder && item.isSerialized && !item.serialUnitId);
    const chosenUnits = pendingUnits.map((item) => conversionUnitChoices[item.reservationItemId]).filter(Boolean);
    if (chosenUnits.length !== pendingUnits.length) {
      setMessage('Escolha a unidade (serial) que chegou para cada item de encomenda.');
      return;
    }
    if (new Set(chosenUnits).size !== chosenUnits.length) {
      setMessage('Escolha unidades diferentes para cada item de encomenda.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const saleId = crypto.randomUUID();
    try {
      const result = await saleRpc.processTransaction({
        saleId,
        invoiceNumber: `PDV-${Date.now()}`,
        reservationId: reservation.id,
        items: reservation.items.map((item) => {
          const chosenUnitId = conversionUnitChoices[item.reservationItemId];
          const chosenUnit = chosenUnitId
            ? conversionUnitOptions[item.productId]?.find((unit) => unit.serialUnitId === chosenUnitId)
            : undefined;
          return {
            itemType: 'PRODUCT' as const,
            productId: item.productId,
            reservationItemId: item.reservationItemId,
            itemSku: item.itemSku,
            itemName: item.itemName,
            quantity: item.quantity,
            discountPercent: item.discountPercent,
            unitPrice: item.unitPrice,
            lineTotal: item.lineTotal,
            ...(item.serialNumber ? { serials: [item.serialNumber] } : {}),
            ...(!item.serialNumber && chosenUnit
              ? { serialUnitId: chosenUnit.serialUnitId, serials: [chosenUnit.serialNumber] }
              : {}),
          };
        }),
        paymentMethod: resolution
          ? legacyPaymentMethod(resolution.applied)
          : reservation.depositPaymentMethod ?? 'DINHEIRO',
        payments: resolution ? withCardSurcharge(resolution.applied, cardFees) : null,
        grossAmount: total,
        feeAmount: 0,
        netAmount: total,
        clientCpf: reservation.customerCpf,
        clientName: reservation.customerName,
        timestamp: new Date().toISOString(),
        status: 'CONCLUIDA',
        requiresApproval: false,
        sellerCode: conversionSeller.code,
      });
      if (result.status === 'INVALID_SELLER') {
        setConversionSeller(null);
        setMessage('Código de vendedor inválido para esta loja. Confira o código e tente de novo.');
        return;
      }
      if (result.status !== 'OK') {
        setMessage('Não foi possível concluir a conversão. Tente novamente.');
        return;
      }
      setReservations(await getPosReservations());
      setConversionReservation(null);
      setConversionUnitChoices({});
      setConversionPaymentLines([]);
      setConversionSellerCode('');
      setConversionSeller(null);
      setMessage(
        `Reserva de ${reservation.customerName} convertida em venda${reservation.sellerName ? ` (venda de ${reservation.sellerName})` : ''}. Saldo pago: ${currency.format(remaining)}.`
          + (resolution && resolution.changeCents > 0 ? ` Troco: ${currency.format(resolution.changeCents / 100)}.` : '')
      );
      void deliverReceipt(saleId, resolution ? resolution.changeCents / 100 : 0);
      if (resolution?.applied.some((line) => line.paymentMethod === 'DINHEIRO')) void openCashDrawer();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  // Com sinal abre a janela da forma de devolucao; sem sinal so confirma.
  function cancelReservation(reservation: PosReservation) {
    if (reservation.depositAmount > 0) {
      setCancelTarget(reservation);
      return;
    }
    if (!window.confirm(`Cancelar a reserva de ${reservation.customerName}?`)) return;
    void confirmCancelReservation(reservation, null);
  }

  async function confirmCancelReservation(reservation: PosReservation, refundMethod: PaymentMethod | null) {
    setBusy(true);
    setMessage(null);
    try {
      if (refundMethod) {
        const denied = await authorizeAction('RESERVATION_CANCEL', managerPassword, false);
        setManagerPassword('');
        if (denied) {
          setMessage(denied);
          return;
        }
      }
      setCancelTarget(null);
      await cancelPosReservation(reservation.id, refundMethod);
      setReservations(await getPosReservations());
      setMessage('Reserva cancelada e produto liberado.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  // Carrinho limpo (cancelar venda, F6...): a cobranca da OS deixa de valer.
  useEffect(() => {
    if (workOrderCharge && !cart.some((item) => item.workOrderId)) setWorkOrderCharge(null);
  }, [cart, workOrderCharge]);

  useEffect(() => {
    if (screen !== 'sale' && screen !== 'receipts') return;
    // Sem internet vale a configuracao guardada (NFC-e pelo Comunicador Offline).
    getPosNfceStatus().then(setNfceConfig).catch(async () => setNfceConfig((await getSnapshot())?.nfce ?? null));
  }, [screen]);

  useEffect(() => {
    if (screen !== 'sale' && screen !== 'reservations') return;
    getPosCardFees().then(setCardFees).catch(() => undefined);
  }, [screen]);

  useEffect(() => {
    if (!saleCustomer) {
      setCustomerCredit(0);
      return;
    }
    getCustomerCreditBalance(saleCustomer.cpf).then(setCustomerCredit).catch(() => setCustomerCredit(0));
  }, [saleCustomer, screen]);

  // Contingencia: acompanha as NFC-e emitidas com a Sefaz fora do ar (ao abrir e a cada 10 min).
  useEffect(() => {
    if (!nfceConfig?.configured || (screen !== 'sale' && screen !== 'receipts')) return;
    let cancelled = false;
    async function check() {
      const result = await syncNfceContingency();
      if (!cancelled && result && result.errors > 0) {
        setMessage(`Atenção: ${result.errors} NFC-e emitida(s) em contingência foram recusadas pela Sefaz. Veja em Cupons e notas e corrija em até 24 horas.`);
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [nfceConfig?.configured, screen]);

  useEffect(() => {
    if (!terminal) return;
    let cancelled = false;
    let lastSnapshot = 0;
    async function tick() {
      const online = await probeOnline();
      if (cancelled) return;
      const wasOffline = isOffline();
      setOffline(!online);
      if (!online) return;
      const result = await syncOutbox();
      if (result.sent > 0 || result.failed > 0) {
        setMessage(`Vendas sem internet enviadas: ${result.sent}${result.failed > 0 ? `; ${result.failed} com erro (veja na faixa no topo)` : ''}${result.conflicts > 0 ? `; ${result.conflicts} divergência(s) para o gerente conferir no ERP` : ''}.`);
      }
      if (cashSession && Date.now() - lastSnapshot > 5 * 60 * 1000) {
        lastSnapshot = Date.now();
        void refreshSnapshot();
      }
    }
    void refreshCounts();
    void tick();
    const timer = window.setInterval(() => void tick(), 20 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [terminal, cashSession]);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  useEffect(() => {
    if (!cashSession || offlineNow) return;
    getCashSessionReport().then((report) => setSessionNumber(report?.sessionNumber ?? null)).catch(() => undefined);
  }, [cashSession, offlineNow]);

  // Sair da venda para o menu descarta a venda em andamento (proxima venda comeca limpa).
  function leaveSaleToMenu() {
    setCart([]);
    setCatalogItems([]);
    setQuery('');
    setPaymentLines([]);
    setSaleSellerCode('');
    setSaleSeller(null);
    setSaleCustomer(null);
    setWorkOrderCharge(null);
    setAdminApprovalPassword('');
    setMessage(null);
    setScreen('menu');
  }

  useEffect(() => {
    if (screen !== 'sale') return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (serialProduct || adminApprovalOpen || customerPickerOpen || customerForm || nfceProblem || offlineCustomerOpen || returnSaleId) return;
      if (catalogItems.length > 0 || query) {
        setCatalogItems([]);
        setQuery('');
        return;
      }
      leaveSaleToMenu();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Aviso de atualizacao so fora de uma venda/reserva em andamento.
  useEffect(() => {
    const sellingNow = (screen === 'sale' || screen === 'new-reservation') && cart.length > 0;
    setUpdateAllowed(!sellingNow && !busy && !nfceEmitting && !conversionReservation && !nfceProblem);
  }, [screen, cart.length, busy, nfceEmitting, conversionReservation, nfceProblem]);

  const nfceModal = nfceProblem && (
    <NfceProblemModal
      problem={nfceProblem}
      busy={nfceEmitting}
      onRetry={() => void emitNfce(nfceProblem.saleId, nfceProblem.change)}
      onPrintNonFiscal={() => {
        const { saleId, change } = nfceProblem;
        setNfceProblem(null);
        setMessage('Cupom Não Fiscal impresso. A NFC-e desta venda ficou pendente: emita depois pela tela de cupons (impressora no topo).');
        void printReceipt(saleId, change);
      }}
      onClose={() => {
        setNfceProblem(null);
        setMessage('A NFC-e desta venda ficou pendente. Emita depois pela tela de cupons (impressora no topo).');
      }}
    />
  );

  const grossAmount = cart.reduce((total, item) => total + discountedLineTotal(item), 0);
  const cartHasBackorder = cart.some((item) => item.backorder);
  // Servicos ficam fora da NFC-e: venda so com servicos sai como Nao Fiscal.
  const cartHasProduct = cart.some((item) => item.itemType === 'PRODUCT');
  const reservationDepositAmount = valueAsNumber(reservationDeposit);

  useEffect(() => {
    if (!conversionReservation || !terminal) return;
    const productIds = Array.from(new Set(conversionReservation.items
      .filter((item) => item.isBackorder && item.isSerialized && !item.serialUnitId)
      .map((item) => item.productId)));
    setConversionUnitChoices({});
    setConversionUnitOptions({});
    if (productIds.length === 0) return;
    let active = true;
    Promise.all(productIds.map(async (productId) =>
      [productId, await getPosAvailableSerialUnits(productId, terminal.unitId)] as const))
      .then((entries) => { if (active) setConversionUnitOptions(Object.fromEntries(entries)); })
      .catch((error) => { if (active) setMessage(errorMessage(error)); });
    return () => { active = false; };
  }, [conversionReservation, terminal]);

  if (screen === 'loading') {
    return <main className="loading-screen">Preparando dispositivo...</main>;
  }

  if (screen === 'activation') {
    return (
      <AuthFrame>
        <Brand />
        <h1>Ativar terminal</h1>
        <p>Digite o codigo fornecido para vincular este dispositivo a uma loja.</p>
        <form onSubmit={handleActivation}>
          <label>
            Nome do terminal
            <input
              value={terminalName}
              onChange={(event) => setTerminalName(event.target.value)}
              maxLength={80}
              required
            />
          </label>
          <label>
            Codigo de ativacao
            <input
              value={activationCode}
              onChange={(event) => setActivationCode(event.target.value.toUpperCase())}
              placeholder="AB12-CD34-EF56"
              autoCapitalize="characters"
              required
            />
          </label>
          <button className="primary-action" disabled={busy}>
            {busy ? 'Ativando...' : 'Ativar terminal'}
          </button>
        </form>
        <Notice message={message} />
      </AuthFrame>
    );
  }

  if (screen === 'set-password') {
    return (
      <AuthFrame>
        <Brand />
        <StoreDetails terminal={terminal} />
        <h1>Cadastre a senha Gerente</h1>
        <p>
          Esta loja ainda não tem senha Gerente. O dono cadastra no ERP, em Configurações, na loja.
          Ela vale para todos os PDVs da loja e é pedida para desbloquear o terminal e liberar ações do caixa.
        </p>
        <button className="primary-action" type="button" disabled={busy} onClick={() => void recheckManagerPassword()}>
          {busy ? 'Conferindo...' : 'Já cadastrei, continuar'}
        </button>
        <Notice message={message} />
      </AuthFrame>
    );
  }

  if (screen === 'unlock') {
    return (
      <AuthFrame>
        <Brand />
        <StoreDetails terminal={terminal} />
        <h1>Desbloquear terminal</h1>
        <p>Informe a senha Gerente para abrir o PDV.</p>
        <form onSubmit={handleUnlock}>
          <label>
            Senha Gerente
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
          </label>
          <button className="primary-action" disabled={busy}>
            <LockKeyhole size={20} />
            {busy ? 'Desbloqueando...' : 'Desbloquear'}
          </button>
        </form>
        <Notice message={message} />
      </AuthFrame>
    );
  }

  if (screen === 'cash-open') {
    return (
      <AuthFrame>
        <Brand />
        <StoreDetails terminal={terminal} />
        <h1>Abrir caixa</h1>
        <p>Abra o caixa antes de registrar vendas neste terminal.</p>
        <form onSubmit={handleCashOpen}>
          <label>
            Numero do caixa
            <input value={cashNumber} onChange={(event) => setCashNumber(event.target.value)} required />
          </label>
          <label>
            Responsavel pela abertura
            <input
              value={responsibleName}
              onChange={(event) => setResponsibleName(event.target.value)}
              required
            />
          </label>
          <label>
            Troco inicial (R$)
            <ValueInput
              value={parseValueText(openingFloat)}
              onValueChange={(value) => setOpeningFloat(formatValueText(value, 2))}
              required
            />
          </label>
          <button className="primary-action" disabled={busy}>
            <WalletCards size={20} />
            {busy ? 'Abrindo...' : 'Abrir caixa'}
          </button>
        </form>
        <Notice message={message} />
      </AuthFrame>
    );
  }

  if (screen === 'cash-movement') {
    return (
      <AuthFrame>
        <Brand />
        <h1>{movementType === 'SANGRIA' ? 'Registrar sangria' : 'Registrar suprimento'}</h1>
        <p>
          {movementType === 'SANGRIA'
            ? 'Registre uma retirada de dinheiro do caixa.'
            : 'Registre um reforco de dinheiro no caixa.'}
        </p>
        <form onSubmit={handleMovement}>
          <label>
            Responsavel
            <input
              value={responsibleName}
              onChange={(event) => setResponsibleName(event.target.value)}
              required
            />
          </label>
          <label>
            Valor (R$)
            <ValueInput
              value={parseValueText(movementAmount)}
              onValueChange={(value) => setMovementAmount(formatValueText(value, 2))}
              required
            />
          </label>
          <label>
            Motivo
            <input
              value={movementReason}
              onChange={(event) => setMovementReason(event.target.value)}
              required
            />
          </label>
          <label>
            Senha Gerente
            <input
              type="password"
              value={managerPassword}
              onChange={(event) => setManagerPassword(event.target.value)}
              autoComplete="off"
              required
            />
          </label>
          <button className="primary-action" disabled={busy}>
            {busy ? 'Registrando...' : 'Confirmar'}
          </button>
        </form>
        <button className="text-action" type="button" onClick={() => setScreen('menu')}>
          Voltar ao menu
        </button>
        <Notice message={message} />
      </AuthFrame>
    );
  }

  if (screen === 'cash-close' && closure) {
    return (
      <AuthFrame>
        <Brand />
        <h1>Fechar caixa</h1>
        <p>
          {closure.cashNumber} aberto por {closure.openedByName}.
        </p>
        <form onSubmit={handleCashClose}>
          <label>
            Responsavel pelo fechamento
            <input
              value={responsibleName}
              onChange={(event) => setResponsibleName(event.target.value)}
              required
            />
          </label>
          <CashCount
            label="Dinheiro"
            expected={closure.expectedCashAmount}
            value={counts.cash}
            onChange={(value) => setCounts({ ...counts, cash: value })}
          />
          <CashCount
            label="Pix"
            expected={closure.expectedPixAmount}
            value={counts.pix}
            onChange={(value) => setCounts({ ...counts, pix: value })}
          />
          <CashCount
            label="Credito"
            expected={closure.expectedCreditAmount}
            value={counts.credit}
            onChange={(value) => setCounts({ ...counts, credit: value })}
          />
          <CashCount
            label="Debito"
            expected={closure.expectedDebitAmount}
            value={counts.debit}
            onChange={(value) => setCounts({ ...counts, debit: value })}
          />
          <CashCount
            label="Voucher"
            expected={closure.expectedVoucherAmount}
            value={counts.voucher}
            onChange={(value) => setCounts({ ...counts, voucher: value })}
          />
          <CashCount
            label="Crediario"
            expected={closure.expectedCreditAccountAmount}
            value={counts.creditAccount}
            onChange={(value) => setCounts({ ...counts, creditAccount: value })}
          />
          <label>
            Observacoes
            <textarea value={closureNotes} onChange={(event) => setClosureNotes(event.target.value)} />
          </label>
          <label>
            Senha Gerente
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="primary-action" disabled={busy}>
            {busy ? 'Fechando...' : 'Confirmar fechamento'}
          </button>
        </form>
        <Notice message={message} />
      </AuthFrame>
    );
  }

  if (screen === 'trade-in') {
    return (
      <main className="sale-shell">
        <header className="sale-header">
          <div>
            <Brand compact />
            <div>
              <strong>Troca Gamer</strong>
              <span>{terminal?.tradeName ?? terminal?.unitId}</span>
            </div>
          </div>
          <div className="header-actions">
            <button className="text-action reservation-back" type="button" onClick={() => setScreen('menu')}>
              Voltar ao menu
            </button>
          </div>
        </header>
        <TradeInPanel
          key={tradeInKey}
          seller={tradeSeller}
          sellerSlot={(
            <SellerCodeField
              label="Código do vendedor"
              value={tradeSellerCode}
              seller={tradeSeller}
              disabled={false}
              onValue={setTradeSellerCode}
              onSeller={setTradeSeller}
            />
          )}
          loadStore={loadStoreProfile}
          onPaidCash={() => void openCashDrawer()}
          onDone={(result) => void finishTradeIn(result)}
        />
      </main>
    );
  }

  if (screen === 'work-orders') {
    return (
      <main className="sale-shell">
        <header className="sale-header">
          <div>
            <Brand compact />
            <div>
              <strong>Ordens de serviço</strong>
              <span>{terminal?.tradeName ?? terminal?.unitId}</span>
            </div>
          </div>
          <div className="header-actions">
            <button className="text-action reservation-back" type="button" onClick={() => setScreen('menu')}>
              Voltar ao menu
            </button>
          </div>
        </header>
        <WorkOrdersPanel
          key={workOrdersKey}
          seller={workOrderSeller}
          sellerSlot={(
            <SellerCodeField
              label="Código do vendedor"
              value={workOrderSellerCode}
              seller={workOrderSeller}
              disabled={false}
              onValue={setWorkOrderSellerCode}
              onSeller={setWorkOrderSeller}
            />
          )}
          initialOrderId={workOrderFocus}
          loadStore={loadStoreProfile}
          onCharge={chargeWorkOrder}
        />
      </main>
    );
  }

  if (screen === 'warranty') {
    return (
      <main className="sale-shell">
        <header className="sale-header">
          <div>
            <Brand compact />
            <div>
              <strong>Garantia</strong>
              <span>{terminal?.tradeName ?? terminal?.unitId}</span>
            </div>
          </div>
          <div className="header-actions">
            <button className="text-action reservation-back" type="button" onClick={() => setScreen('menu')}>
              Voltar ao menu
            </button>
          </div>
        </header>
        <WarrantyPanel />
      </main>
    );
  }

  if (screen === 'receipts') {
    return (
      <main className="sale-shell">
        <header className="sale-header">
          <div>
            <Brand compact />
            <div>
              <strong>Cupons e notas</strong>
              <span>{terminal?.tradeName ?? terminal?.unitId}</span>
            </div>
          </div>
          <div className="header-actions">
            <button
              className="text-action"
              type="button"
              title="Porta do Comunicador Offline da Focus neste computador (NFC-e sem internet)"
              onClick={() => {
                const port = window.prompt('Porta do Comunicador Offline da Focus neste computador (em branco = desligado):', getComunicadorPort() ?? '');
                if (port === null) return;
                const clean = port.replace(/D/g, '');
                setComunicadorPort(clean || null);
                setMessage(clean ? `Comunicador Offline configurado na porta ${clean}.` : 'Comunicador Offline desligado neste computador.');
              }}
            >
              Comunicador Offline{getComunicadorPort() ? ` (porta ${getComunicadorPort()})` : ''}
            </button>
            <button className="text-action reservation-back" type="button" onClick={() => { setMessage(null); setScreen('menu'); }}>
              Voltar ao menu
            </button>
          </div>
        </header>
        <div className="receipts-notice"><Notice message={message} /></div>
        <ReceiptsPanel
          nfceConfigured={nfceConfig?.configured === true}
          busy={busy || nfceEmitting}
          onReprint={(saleId) => printReceipt(saleId)}
          onEmitNfce={(saleId) => emitNfce(saleId, 0)}
          onReturn={(saleId) => { setMessage(null); setReturnSaleId(saleId); }}
        />
        {returnSaleId && (
          <ReturnModal
            saleId={returnSaleId}
            loadStore={loadStoreProfile}
            onClose={() => setReturnSaleId(null)}
            onDone={(result) => void finishReturn(result)}
          />
        )}
        {nfceModal}
      </main>
    );
  }

  if (screen === 'reservations') {
    return (
      <main className="sale-shell">
        <header className="sale-header">
          <div>
            <Brand compact />
            <div>
              <strong>Reservas da loja</strong>
              <span>{terminal?.tradeName ?? terminal?.unitId} | {reservations.length} ativa(s)</span>
            </div>
          </div>
          <div className="header-actions reservation-header-actions">
            <button className="primary-action new-reservation-button" type="button" onClick={startNewReservation} disabled={busy}>
              <Plus size={18} /> Nova reserva
            </button>
            <button className="text-action reservation-back" type="button" onClick={() => setScreen('menu')}>
              Voltar ao menu
            </button>
          </div>
        </header>
        <section className="reservations-panel">
          <Notice message={message} />
          {reservationsLoading || busy ? (
            <p className="empty-state">Carregando reservas...</p>
          ) : reservations.length === 0 ? (
            <p className="empty-state">Nenhuma reserva ativa nesta loja.</p>
          ) : (
            <div className="reservation-list">
              {reservations.map((reservation) => {
                const total = reservation.items.reduce((sum, item) => sum + item.lineTotal, 0);
                const waitingStock = reservation.items.some((item) => item.stockReady === false);
                return (
                  <article className={`reservation-entry${reservation.expired ? ' is-expired' : ''}`} key={reservation.id}>
                    <div className="reservation-entry-heading">
                      <div>
                        <h2>{reservation.customerName}</h2>
                        {reservation.customerPhone && <small>{reservation.customerPhone}</small>}
                        {reservation.customerCpf && <small>CPF {formatCpf(reservation.customerCpf)}</small>}
                      </div>
                      <span className={`reservation-status${reservation.expired ? ' expired' : ''}`}>
                        {reservation.expired ? 'VENCIDA · RESERVA ATIVA' : 'ATIVA'}
                      </span>
                    </div>
                    <p className="reservation-deadline">Prazo: {formatDateTime(reservation.expiresAt)}</p>
                    <p className="reservation-deadline">
                      Vendedor: {reservation.sellerName ? `${reservation.sellerName} (${reservation.sellerCode})` : 'não informado'}
                    </p>
                    <ul className="reservation-items">
                      {reservation.items.map((item) => (
                        <li key={item.reservationItemId}>
                          <span>
                            <strong>{item.itemName}</strong>
                            <small>
                              {item.itemSku}{item.serialNumber ? ` | Série ${item.serialNumber}` : ` | ${item.quantity} un.`}
                              {item.isBackorder && !item.serialNumber && <span className="backorder-tag">Encomenda</span>}
                            </small>
                          </span>
                          <strong>{currency.format(item.lineTotal)}</strong>
                        </li>
                      ))}
                    </ul>
                    <div className="reservation-totals">
                      <span>Total {currency.format(total)}</span>
                      <span>Sinal {currency.format(reservation.depositAmount)}</span>
                      <strong>Saldo {currency.format(Math.max(0, total - reservation.depositAmount))}</strong>
                    </div>
                    {waitingStock && (
                      <p className="reservation-waiting">
                        <CircleAlert size={16} /> Produto ainda sem estoque: não é possível finalizar a venda. Dê entrada no estoque quando a mercadoria chegar.
                      </p>
                    )}
                    <div className="reservation-actions">
                      <button className="primary-action reservation-convert" type="button" disabled={busy || waitingStock} onClick={() => {
                        setConversionPaymentLines([]);
                        setMessage(null);
                        setConversionReservation(reservation);
                      }}>
                        <CreditCard size={18} /> Converter em venda
                      </button>
                      <button className="text-action reservation-reprint" type="button" disabled={busy} onClick={() => void printVoucher(voucherFromReservation(reservation))}>
                        Reimprimir voucher
                      </button>
                      <button className="reservation-cancel" type="button" disabled={busy} onClick={() => cancelReservation(reservation)}>
                        Cancelar reserva
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
        {conversionReservation && (
          <ReservationPaymentModal
            reservation={conversionReservation}
            paymentLines={conversionPaymentLines}
            cardFees={cardFees}
            busy={busy}
            message={message}
            sellerCode={conversionSellerCode}
            seller={conversionSeller}
            onSellerCode={setConversionSellerCode}
            onSeller={setConversionSeller}
            onPaymentLines={setConversionPaymentLines}
            unitOptions={conversionUnitOptions}
            unitChoices={conversionUnitChoices}
            onUnitChoice={(reservationItemId, unitId) =>
              setConversionUnitChoices((current) => ({ ...current, [reservationItemId]: unitId }))}
            onClose={() => {
              setConversionReservation(null);
              setConversionUnitChoices({});
              setConversionSellerCode('');
              setConversionSeller(null);
            }}
            nfceConfig={nfceConfig}
            onConfirm={(fiscal) => void convertReservationToSale(conversionReservation, conversionPaymentLines, fiscal)}
          />
        )}
        {cancelTarget && (
          <div className="modal-backdrop" role="presentation">
            <section className="serial-unit-modal" role="dialog" aria-modal="true" aria-labelledby="cancel-reservation-title">
              <div className="modal-heading">
                <div>
                  <p className="eyebrow">Cancelar reserva de {cancelTarget.customerName}</p>
                  <h2 id="cancel-reservation-title">Como o sinal de {currency.format(cancelTarget.depositAmount)} foi devolvido?</h2>
                </div>
                <button className="icon-button" type="button" title="Voltar" onClick={() => { setCancelTarget(null); setManagerPassword(''); }}><X size={20} /></button>
              </div>
              <p className="modal-copy">
                A devolução fica registrada no caixa e entra no fechamento. Estorno no cartão ou Pix deve ser feito na maquininha/banco.
              </p>
              <label>
                Senha Gerente
                <input
                  type="password"
                  value={managerPassword}
                  onChange={(event) => setManagerPassword(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <Notice message={message} />
              <div className="cancel-refund-options">
                {(['DINHEIRO', 'PIX', 'CREDITO', 'DEBITO'] as PaymentMethod[]).map((method) => (
                  <button key={method} className="reservation-nav" type="button" disabled={busy || !managerPassword} onClick={() => void confirmCancelReservation(cancelTarget, method)}>
                    {PAYMENT_METHOD_LABELS[method]}
                  </button>
                ))}
              </div>
              <div className="modal-actions">
                <button className="text-action" type="button" onClick={() => { setCancelTarget(null); setManagerPassword(''); }}>Não cancelar</button>
              </div>
            </section>
          </div>
        )}
        {nfceModal}
      </main>
    );
  }

  const topBarProps = {
    storeName: terminal?.tradeName ?? terminal?.unitId ?? '',
    cashNumber: cashSession?.cashNumber ?? null,
    cashDate: cashSession ? new Date(cashSession.openedAt).toLocaleDateString('pt-BR') : null,
    sessionNumber,
    operator: cashSession?.openedByName ?? null,
  };

  if (screen === 'menu') {
    return (
      <main className="sale-shell menu-shell">
        <TopBar {...topBarProps} subtitle="Kanguru PDV" />
        {message && <div className="menu-notice"><Notice message={message} /></div>}
        <HomeMenu
          offline={offlineNow}
          drawerAvailable={Boolean(directPrinter)}
          cashOpen={Boolean(cashSession)}
          version={appVersion}
          onAction={handleMenuAction}
          onRequestSettings={(open) => {
            setMessage(null);
            setManagerPassword('');
            setManagerPrompt({ action: 'PDV_SETTINGS', title: 'Configurações', confirm: 'Abrir Configurações', onAuthorized: open });
          }}
        />
        {managerPrompt && (
          <div className="modal-backdrop" role="presentation">
            <form
              className="serial-unit-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="drawer-auth-title"
              onSubmit={(event) => {
                event.preventDefault();
                void (async () => {
                  setBusy(true);
                  const denied = await authorizeAction(managerPrompt.action, managerPassword, true);
                  setBusy(false);
                  setManagerPassword('');
                  if (denied) {
                    setMessage(denied);
                    return;
                  }
                  const { onAuthorized } = managerPrompt;
                  setManagerPrompt(null);
                  onAuthorized();
                })();
              }}
            >
              <div className="modal-heading">
                <div>
                  <p className="eyebrow">{managerPrompt.title}</p>
                  <h2 id="drawer-auth-title">Senha Gerente</h2>
                </div>
                <button className="icon-button" type="button" title="Fechar" onClick={() => { setManagerPrompt(null); setManagerPassword(''); }}><X size={20} /></button>
              </div>
              <label>
                Senha Gerente
                <input type="password" autoFocus autoComplete="off" value={managerPassword} onChange={(event) => setManagerPassword(event.target.value)} />
              </label>
              <Notice message={message} />
              <div className="modal-actions">
                <button className="text-action" type="button" onClick={() => { setManagerPrompt(null); setManagerPassword(''); }}>Cancelar</button>
                <button className="primary-action modal-confirm" type="submit" disabled={busy || !managerPassword}>{managerPrompt.confirm}</button>
              </div>
            </form>
          </div>
        )}
        {printerOpen && (
          <PrinterSettingsModal
            onClose={() => setPrinterOpen(false)}
            onSaved={(text) => {
              setPrinterOpen(false);
              setDirectPrinterState(getDirectPrinter());
              setMessage(text);
            }}
          />
        )}
        {lookupOpen && <ProductLookupModal onClose={() => setLookupOpen(false)} />}
        {nfceModal}
      </main>
    );
  }

  return (
    <main className="sale-shell sale-shell-fit">
      <TopBar
        {...topBarProps}
        subtitle={reservationMode ? 'Nova reserva' : 'Nova venda'}
        leading={reservationMode ? (
          <button className="top-bar-menu" type="button" onClick={leaveNewReservation} disabled={busy}>
            <ArrowLeft size={18} /> Reservas
          </button>
        ) : (
          <button className="top-bar-menu" type="button" onClick={leaveSaleToMenu} disabled={busy}>
            <LayoutGrid size={18} /> Menu <small>(Esc)</small>
          </button>
        )}
      />

      <section className="sale-layout">
        <section className="catalog-panel">
          <h1>{reservationMode ? 'Nova reserva' : 'Nova venda'}</h1>
          <form className="search-form" onSubmit={handleSearch}>
            <input
              ref={searchInputRef}
              placeholder="Bipe o código ou serial, ou busque por nome/marca"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
            <button className="icon-button search-button" type="submit" disabled={busy} title="Buscar produtos">
              <Search size={21} />
            </button>
          </form>

          <Notice message={message} />

          <div className="product-list">
            {catalogItems.map((item) => (
              <button
                className={`product-row${item.itemType === 'PRODUCT' && item.availableQuantity <= 0 ? ' is-out-of-stock' : ''}`}
                type="button"
                key={`${item.itemType}-${item.id}`}
                onClick={() => void selectProduct(item)}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.itemType === 'SERVICE' ? 'Serviço' : 'Produto'} | {item.sku}
                    {item.brand ? ` | ${item.brand}` : ''}
                  </small>
                  {item.itemType === 'PRODUCT' && <small>{warrantyLabel(item.warrantyMonths)}</small>}
                  {item.requiresUnitSelection && <small>Serializado: selecione a unidade.</small>}
                </span>
                <span>
                  <strong>{currency.format(item.sellPrice)}</strong>
                  {item.itemType === 'SERVICE' ? (
                    <small>Sem estoque físico</small>
                  ) : item.availableQuantity > 0 ? (
                    <small>{item.availableQuantity} em estoque</small>
                  ) : (
                    <>
                      <small className="stock-out">Sem estoque</small>
                      {item.storesWithStock.length > 0 && (
                        <small className="stock-elsewhere">Possui estoque: {item.storesWithStock.join(', ')}</small>
                      )}
                    </>
                  )}
                </span>
              </button>
            ))}

            {query && catalogItems.length === 0 && !busy && (
              <p className="empty-state">Nenhum item encontrado.</p>
            )}
          </div>
        </section>

        <aside className="cart-panel">
          <div className="cart-heading">
            <h2>{reservationMode ? 'Itens da reserva' : 'Carrinho'}</h2>
            {cartHasOverLimitDiscount() && (
              <small className="discount-warning">
                Itens acima do limite exigem a senha Gerente na finalização.
              </small>
            )}
          </div>
          {workOrderCharge && (
            <div className="work-order-charge">
              <span>Cobrando a <strong>OS nº {workOrderCharge.order.orderNumber}</strong>{workOrderCharge.deliver ? ' (entrega)' : ''} · {workOrderCharge.order.customerName}</span>
              <button className="text-action" type="button" onClick={cancelWorkOrderCharge} disabled={busy}>Cancelar cobrança</button>
            </div>
          )}
          <div className="cart-list">
            {cart.length === 0 ? (
              <p className="empty-state">Adicione um produto para iniciar.</p>
            ) : (
              cart.map((item) => (
                <div className="cart-item" key={item.serialUnit?.serialUnitId ?? `${item.itemType}-${item.id}${item.backorder ? '-encomenda' : ''}${item.workOrderId ? `-${item.workOrderId}` : ''}`}>
                  <div>
                    <strong>{item.name}</strong>
                    {item.backorder && <span className="backorder-tag">Encomenda · sem estoque</span>}
                    {item.workOrderNumber && <span className="backorder-tag work-order-tag">OS nº {item.workOrderNumber}</span>}
                    <small>{item.itemType === 'SERVICE' ? 'Serviço' : 'Produto'} | {currency.format(item.sellPrice)} cada</small>
                    {item.serialUnit ? (
                      <>
                        <small>Serial: {item.serialUnit.serialNumber}</small>
                        {item.serialUnit.imei && <small>IMEI: {item.serialUnit.imei}</small>}
                      </>
                    ) : null}
                    <label className="cart-discount-label">
                      Desconto (%) <small className="discount-limit">limite {item.maxItemDiscountPercent}%</small>
                      <ValueInput
                        aria-label={`Desconto percentual de ${item.name}`}
                        placeholder="0"
                        value={item.discountPercent || null}
                        onValueChange={(value) => updateItemDiscount(item.id, item.itemType, Math.min(100, value ?? 0))}
                      />
                    </label>
                  </div>
                  {item.workOrderId ? null : item.serialUnit ? (
                    <button
                      className="remove-serial-unit"
                      type="button"
                      onClick={() => setCart((current) => current.filter((cartItem) => cartItem !== item))}
                      title="Remover esta unidade"
                    >
                      <Trash2 size={16} />
                    </button>
                  ) : (
                    <div className="quantity-control">
                      <button
                        type="button"
                        onClick={() => changeQuantity(item.id, item.itemType, -1)}
                        title="Remover uma unidade"
                      >
                        <Minus size={16} />
                      </button>
                      <span>{item.quantity}</span>
                      <button
                        type="button"
                        onClick={() => changeQuantity(item.id, item.itemType, 1)}
                        title="Adicionar uma unidade"
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  )}
                  <strong>{currency.format(discountedLineTotal(item))}</strong>
                </div>
              ))
            )}
          </div>

          {reservationMode ? (
            <>
              <form id="new-reservation-form" className="reservation-inline" onSubmit={(event) => void submitReservation(event)}>
                <ReservationFields
                  customerName={reservationCustomerName}
                  customerPhone={reservationCustomerPhone}
                  customerCpf={reservationCustomerCpf}
                  onCustomerCpf={(value) => setReservationCustomerCpf(maskCpf(value))}
                  hasBackorder={cartHasBackorder}
                  expiresOn={reservationExpiresOn}
                  deposit={reservationDeposit}
                  paymentMethod={paymentMethod}
                  busy={busy}
                  onPickCustomer={() => setCustomerPickerOpen(true)}
                  onCustomerName={setReservationCustomerName}
                  onCustomerPhone={setReservationCustomerPhone}
                  onExpiresOn={setReservationExpiresOn}
                  onDeposit={setReservationDeposit}
                  onPaymentMethod={(value) => setPaymentMethod(value)}
                />
              </form>
              <div className="cart-footer">
                <div className="reservation-modal-summary">
                  <span>Total reservado</span><strong>{currency.format(grossAmount)}</strong>
                  <span>Sinal</span><strong>{currency.format(reservationDepositAmount)}</strong>
                  <span>Saldo na conversão</span><strong>{currency.format(Math.max(0, grossAmount - reservationDepositAmount))}</strong>
                </div>
                <SellerCodeField
                  label="Código do vendedor (fica com a venda)"
                  value={reservationSellerCode}
                  seller={reservationSeller}
                  disabled={busy}
                  onValue={setReservationSellerCode}
                  onSeller={setReservationSeller}
                />
                <button
                  className="primary-action finish-button"
                  type="submit"
                  form="new-reservation-form"
                  disabled={busy || cart.length === 0 || reservationDepositAmount > grossAmount || !reservationSeller || !isValidCpf(reservationCustomerCpf)}
                >
                  <ClipboardList size={20} />
                  {busy ? 'Registrando...' : 'Confirmar reserva'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="sale-customer">
                <span className="sale-customer-label"><UserRound size={16} /> Cliente (opcional)</span>
                {saleCustomer ? (
                  <div className="sale-customer-selected">
                    <div>
                      <strong>{saleCustomer.name}</strong>
                      <small>CPF {formatCpf(saleCustomer.cpf)} | {saleCustomer.phone}</small>
                    </div>
                    <div className="sale-customer-actions">
                      <button className="text-action" type="button" onClick={() => setCustomerForm({ customer: saleCustomer, cpf: '' })}>Editar</button>
                      <button className="text-action" type="button" onClick={() => (offlineNow ? setOfflineCustomerOpen(true) : setCustomerPickerOpen(true))}>Trocar</button>
                      <button className="text-action" type="button" onClick={() => setSaleCustomer(null)}>Remover</button>
                    </div>
                    {customerCredit > 0 && (
                      <div className="sale-customer-credit">
                        <small>Vale-troca disponível: {currency.format(customerCredit)}</small>
                        <button className="text-action" type="button" disabled={busy || grossAmount <= 0} onClick={applyCustomerCredit}>Usar vale-troca</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button className="customer-pick" type="button" disabled={busy} onClick={() => (offlineNow ? setOfflineCustomerOpen(true) : setCustomerPickerOpen(true))}>
                    <Search size={16} /> Selecionar ou cadastrar cliente
                  </button>
                )}
              </div>

              <PaymentLinesEditor
                lines={paymentLines}
                total={grossAmount}
                totalLabel="Total da venda"
                busy={busy}
                cardFees={cardFees}
                onChange={setPaymentLines}
              />

              <div className="cart-footer">
                <div className="cart-footer-row">
                  <SellerCodeField
                    label="Código do vendedor"
                    value={saleSellerCode}
                    seller={saleSeller}
                    disabled={busy}
                    onValue={setSaleSellerCode}
                    onSeller={setSaleSeller}
                  />
                  <div className="total-row">
                    <span>Total</span>
                    {/* Com "Repassar taxa" o total ja mostra o valor com os juros do cartao. */}
                    <strong>{currency.format(grossAmount + surchargeTotal(withCardSurcharge(paymentLines, cardFees)))}</strong>
                  </div>
                </div>

                <div className="finish-choice">
                  <button
                    className="primary-action finish-button finish-nfce"
                    type="button"
                    disabled={!nfceConfig?.configured || busy || nfceEmitting || cart.length === 0 || !saleSeller || cartHasBackorder || !cartHasProduct}
                    title={!nfceConfig?.configured ? 'NFC-e não configurada para esta loja.' : !cartHasProduct && cart.length > 0 ? 'Venda só com serviços não gera NFC-e: use Não Fiscal.' : 'Finalizar com NFC-e'}
                    onClick={() => void finalizeSale('NFCE')}
                  >
                    <CreditCard size={20} />
                    {nfceEmitting ? 'Emitindo...' : 'NFC-e'}
                    {!nfceConfig?.configured
                      ? <small>não configurada</small>
                      : !cartHasProduct && cart.length > 0
                        ? <small>só serviços</small>
                        : nfceConfig.environment === 'homologacao' && <small>teste</small>}
                  </button>
                  <button
                    className="primary-action finish-button"
                    type="button"
                    disabled={busy || nfceEmitting || cart.length === 0 || !saleSeller || cartHasBackorder}
                    onClick={() => void finalizeSale('NAO_FISCAL')}
                  >
                    <CreditCard size={20} />
                    {busy ? 'Processando...' : 'Não Fiscal'}
                  </button>
                </div>
              </div>
            </>
          )}
        </aside>
      </section>
      {nfceModal}
      {offlineCustomerOpen && (
        <OfflineCustomerModal
          onConfirm={(customer) => {
            setSaleCustomer(customer);
            setOfflineCustomerOpen(false);
          }}
          onClose={() => setOfflineCustomerOpen(false)}
        />
      )}
      {serialProduct && (
        <SerialUnitModal
          product={serialProduct}
          units={serialUnits}
          selectedUnitId={selectedSerialUnitId}
          loading={serialUnitsLoading}
          error={serialUnitsError}
          onSelect={setSelectedSerialUnitId}
          onClose={closeSerialUnitModal}
          onConfirm={addSelectedSerialUnit}
        />
      )}
      {adminApprovalOpen && (
        <AdminApprovalModal
          password={adminApprovalPassword}
          error={adminApprovalError}
          busy={busy}
          cartItems={cart}
          onPassword={setAdminApprovalPassword}
          onClose={() => {
            if (!busy) {
              setAdminApprovalOpen(false);
              setAdminApprovalPassword('');
              setAdminApprovalError(null);
            }
          }}
          onConfirm={() => void confirmDiscountApproval()}
        />
      )}
      {customerPickerOpen && (
        <CustomerPickerModal
          onSelect={(customer) => {
            if (reservationMode) fillReservationCustomer(customer);
            else setSaleCustomer(customer);
            setCustomerPickerOpen(false);
          }}
          onNew={(cpf) => {
            setCustomerPickerOpen(false);
            setCustomerForm({ customer: null, cpf });
          }}
          onClose={() => setCustomerPickerOpen(false)}
        />
      )}
      {customerForm && (
        <CustomerFormModal
          customer={customerForm.customer}
          initialCpf={customerForm.cpf}
          onSaved={(customer) => {
            if (reservationMode) fillReservationCustomer(customer);
            else setSaleCustomer(customer);
            setCustomerForm(null);
            setMessage(`Cliente ${customer.name} vinculado ${reservationMode ? 'à reserva' : 'à venda'}.`);
          }}
          onClose={() => setCustomerForm(null)}
        />
      )}
    </main>
  );
}

interface ReservationFieldsProps {
  customerName: string;
  customerPhone: string;
  customerCpf: string;
  onCustomerCpf: (value: string) => void;
  hasBackorder: boolean;
  expiresOn: string;
  deposit: string;
  paymentMethod: PaymentMethod;
  busy: boolean;
  onPickCustomer: () => void;
  onCustomerName: (value: string) => void;
  onCustomerPhone: (value: string) => void;
  onExpiresOn: (value: string) => void;
  onDeposit: (value: string) => void;
  onPaymentMethod: (value: PaymentMethod) => void;
}

// Dados da reserva no painel da direita da tela "Nova reserva" (o vendedor e o botao ficam no rodape).
function ReservationFields({
  customerName,
  customerPhone,
  customerCpf,
  onCustomerCpf,
  hasBackorder,
  expiresOn,
  deposit,
  paymentMethod,
  busy,
  onPickCustomer,
  onCustomerName,
  onCustomerPhone,
  onExpiresOn,
  onDeposit,
  onPaymentMethod,
}: ReservationFieldsProps) {
  const depositAmount = valueAsNumber(deposit);
  const cpfComplete = customerCpf.replace(/\D/g, '').length === 11;
  const cpfValid = isValidCpf(customerCpf);
  return (
    <>
      <p className="modal-copy">
        {hasBackorder
          ? 'Há itens de encomenda (sem estoque): ficam reservados para este cliente assim que chegarem.'
          : 'Os produtos ficam indisponíveis para outras vendas até a conversão ou o cancelamento.'}
        {' '}Ao confirmar, o voucher é impresso.
      </p>
      <button className="customer-pick" type="button" disabled={busy} onClick={onPickCustomer}>
        <Search size={16} /> Buscar cliente cadastrado
      </button>
      <label>
        Nome do cliente
        <input required maxLength={160} value={customerName} onChange={(event) => onCustomerName(event.target.value)} />
      </label>
      <label>
        CPF do cliente
        <input required inputMode="numeric" placeholder="000.000.000-00" value={customerCpf} onChange={(event) => onCustomerCpf(event.target.value)} />
        {cpfComplete && !cpfValid && <small className="field-error">CPF inválido. Confira os números.</small>}
      </label>
      <label>
        Telefone (opcional)
        <input type="tel" maxLength={40} value={customerPhone} onChange={(event) => onCustomerPhone(event.target.value)} />
      </label>
      <label>
        Data de retirada prevista
        <input type="date" required min={localDateInputValue()} value={expiresOn} onChange={(event) => onExpiresOn(event.target.value)} />
      </label>
      <label>
        Sinal / depósito (opcional)
        <ValueInput value={parseValueText(deposit)} onValueChange={(value) => onDeposit(formatValueText(value, 2))} />
      </label>
      {depositAmount > 0 && (
        <label>
          Forma de recebimento do sinal
          <select value={paymentMethod} onChange={(event) => onPaymentMethod(event.target.value as PaymentMethod)}>
            <option value="DINHEIRO">Dinheiro</option>
            <option value="PIX">Pix</option>
            <option value="CREDITO">Crédito</option>
            <option value="DEBITO">Débito</option>
          </select>
        </label>
      )}
    </>
  );
}

interface NfceProblemModalProps {
  problem: { status: NfceStatus; message: string | null };
  busy: boolean;
  onRetry: () => void;
  onPrintNonFiscal: () => void;
  onClose: () => void;
}

// NFC-e recusada ou sem resposta: a venda ja esta registrada; o vendedor tenta de novo,
// imprime o cupom Nao Fiscal ou deixa a nota pendente para emitir depois.
function NfceProblemModal({ problem, busy, onRetry, onPrintNonFiscal, onClose }: NfceProblemModalProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal" role="dialog" aria-modal="true" aria-labelledby="nfce-problem-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Venda registrada</p>
            <h2 id="nfce-problem-title">{problem.status === 'PENDENTE' ? 'NFC-e pendente' : 'NFC-e não autorizada'}</h2>
          </div>
        </div>
        <p className="modal-copy">
          {problem.message ?? 'A Sefaz não autorizou a NFC-e.'}
        </p>
        <p className="modal-copy">
          A venda já foi registrada. Você pode tentar emitir de novo agora, imprimir o cupom Não Fiscal
          ou deixar a nota pendente e emitir depois pela tela de cupons.
        </p>
        <div className="modal-actions">
          <button className="text-action" type="button" onClick={onClose} disabled={busy}>Deixar pendente</button>
          <button className="reservation-nav" type="button" onClick={onPrintNonFiscal} disabled={busy}>Imprimir Não Fiscal</button>
          <button className="primary-action modal-confirm" type="button" onClick={onRetry} disabled={busy}>
            {busy ? 'Emitindo...' : 'Tentar de novo'}
          </button>
        </div>
      </section>
    </div>
  );
}

interface PaymentLinesEditorProps {
  lines: PaymentLine[];
  total: number;
  totalLabel: string;
  busy: boolean;
  cardFees: CardFeeTable | null;
  onChange: (lines: PaymentLine[]) => void;
}

function PaymentLinesEditor({ lines, total, totalLabel, busy, cardFees, onChange }: PaymentLinesEditorProps) {
  const resolution = resolvePayments(lines, total);
  const totalCents = toCents(total);
  const balanced = resolution.error === null;
  const jurosCents = toCents(surchargeTotal(withCardSurcharge(lines, cardFees)));

  // Cartao com "Repassar taxa" fica travado e sempre cobre o que falta depois das
  // outras formas (a ordem de lancamento nao importa). Com mais de um, ajusta o ultimo.
  function balanceCardLine(next: PaymentLine[]): PaymentLine[] {
    let target = -1;
    next.forEach((line, i) => {
      if (line.passFee && (line.paymentMethod === 'CREDITO' || line.paymentMethod === 'DEBITO')) target = i;
    });
    if (target < 0) return next;
    const otherCents = next.reduce((sum, line, i) => (i === target ? sum : sum + toCents(line.amount)), 0);
    const amount = Math.max(0, totalCents - otherCents) / 100;
    return next[target].amount === amount ? next : next.map((line, i) => (i === target ? { ...line, amount } : line));
  }

  function emit(next: PaymentLine[]) {
    onChange(balanceCardLine(next));
  }

  // Total mudou (item incluido/removido): reajusta o cartao com repasse.
  useEffect(() => {
    const balanced = balanceCardLine(lines);
    if (balanced !== lines) onChange(balanced);
  }, [totalCents]);

  function updateLine(index: number, patch: Partial<PaymentLine>) {
    emit(lines.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  // Linha ainda sem valor: usa o saldo restante (assim o valor com a taxa aparece na hora).
  function fillAmount(line: PaymentLine, otherLinesCents: number): Partial<PaymentLine> {
    if (line.amount) return {};
    const suggested = Math.max(0, totalCents - otherLinesCents) / 100;
    return suggested > 0 ? { amount: suggested } : {};
  }

  return (
    <div className="payment-lines">
      <div className="payment-lines-heading">
        <span>Formas de pagamento</span>
        <button
          className="text-action"
          type="button"
          onClick={() => emit([...lines, { paymentMethod: 'DINHEIRO', amount: 0 }])}
          disabled={busy}
        >
          + Adicionar forma
        </button>
      </div>
      {lines.length === 0 ? (
        <p className="empty-state">Nenhuma forma adicionada.</p>
      ) : (
        lines.map((line, index) => {
          const otherLinesCents = lines.reduce((acc, current, i) => (i === index ? acc : acc + toCents(current.amount)), 0);
          const isCard = line.paymentMethod === 'CREDITO' || line.paymentMethod === 'DEBITO';
          const installments = line.installments ?? 1;
          const rate = isCard ? cardFeeRate(cardFees, line.paymentMethod, installments) : 0;
          const juros = lineSurcharge(cardFees, line);
          const charged = (line.amount || 0) + juros;
          return (
            <div className="payment-line-block" key={`payment-${index}`}>
            <div className="payment-line">
              <select
                aria-label={`Forma ${index + 1}`}
                value={line.paymentMethod}
                onChange={(event) =>
                  updateLine(index, { paymentMethod: event.target.value as PaymentMethod, installments: 1, passFee: false })}
              >
                {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((method) => (
                  <option key={method} value={method}>
                    {PAYMENT_METHOD_LABELS[method]}
                  </option>
                ))}
              </select>
              <ValueInput
                aria-label={`Valor da forma ${index + 1}`}
                // Com "Repassar taxa" mostra o valor com juros (o que passa na maquininha);
                // para mudar o valor, desliga o repasse.
                value={line.passFee && juros > 0 ? charged : Number.isFinite(line.amount) && line.amount ? line.amount : null}
                disabled={busy || (line.passFee && juros > 0)}
                title={line.passFee && juros > 0 ? 'Valor com a taxa. Para mudar, desligue "Repassar taxa".' : undefined}
                onValueChange={(value) => updateLine(index, { amount: value ?? 0 })}
                onFocus={() => {
                  // Pre-preenche com o saldo restante quando o campo esta zerado.
                  if (!line.amount && totalCents > 0) {
                    const suggested = Math.max(0, totalCents - otherLinesCents) / 100;
                    if (suggested > 0) {
                      updateLine(index, { amount: suggested });
                    }
                  }
                }}
              />
              <button
                className="icon-button"
                type="button"
                title="Remover forma"
                onClick={() => emit(lines.filter((_, i) => i !== index))}
              >
                <Trash2 size={16} />
              </button>
            </div>
            {isCard && (
              <div className="payment-card-options">
                {line.paymentMethod === 'CREDITO' && (
                  <select
                    aria-label={`Parcelas da forma ${index + 1}`}
                    value={installments}
                    onChange={(event) => updateLine(index, { installments: Number(event.target.value), ...fillAmount(line, otherLinesCents) })}
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((count) => {
                      const countRate = cardFeeRate(cardFees, 'CREDITO', count);
                      return (
                        <option key={count} value={count}>
                          {count}x{countRate > 0 ? ` (${percentText(countRate)}%)` : ''}
                        </option>
                      );
                    })}
                  </select>
                )}
                {rate > 0 ? (
                  <label className="payment-pass-fee">
                    <input
                      type="checkbox"
                      checked={Boolean(line.passFee)}
                      onChange={(event) => updateLine(index, { passFee: event.target.checked, ...fillAmount(line, otherLinesCents) })}
                    />
                    Repassar taxa ({percentText(rate)}%)
                  </label>
                ) : (
                  <small>Taxa não cadastrada no ERP</small>
                )}
                {line.passFee && juros > 0 ? (
                  line.paymentMethod === 'CREDITO' && installments > 1 ? (
                    <small className="payment-card-charge">
                      <strong>{installments}x de {currency.format(charged / installments)}</strong>
                    </small>
                  ) : null
                ) : rate > 0 ? (
                  <small>A taxa de {percentText(rate)}% fica com a loja</small>
                ) : null}
              </div>
            )}
            </div>
          );
        })
      )}
      <div className="payment-lines-summary">
        <span>{totalLabel}</span>
        <strong>{currency.format((totalCents + jurosCents) / 100)}</strong>
        <span>Soma das formas</span>
        <strong className={balanced ? '' : 'negative'}>{currency.format((resolution.sumCents + jurosCents) / 100)}</strong>
        {resolution.missingCents > 0 && (
          <>
            <span>Falta</span>
            <strong className="negative">{currency.format(resolution.missingCents / 100)}</strong>
          </>
        )}
        {resolution.changeCents > 0 && (
          <>
            <span>Troco</span>
            <strong className={balanced ? 'payment-change' : 'negative'}>
              {currency.format(resolution.changeCents / 100)}
            </strong>
          </>
        )}
      </div>
      {lines.length > 0 && resolution.error && resolution.missingCents === 0 && (
        <small className="payment-lines-error">{resolution.error}</small>
      )}
    </div>
  );
}

interface ReservationPaymentModalProps {
  reservation: PosReservation;
  unitOptions: Record<string, PosSerialUnit[]>;
  unitChoices: Record<string, string>;
  onUnitChoice: (reservationItemId: string, unitId: string) => void;
  paymentLines: PaymentLine[];
  cardFees: CardFeeTable | null;
  busy: boolean;
  message: string | null;
  sellerCode: string;
  seller: PosSeller | null;
  onSellerCode: (value: string) => void;
  onSeller: (seller: PosSeller | null) => void;
  onPaymentLines: (lines: PaymentLine[]) => void;
  onClose: () => void;
  nfceConfig: PosNfceStatus | null;
  onConfirm: (fiscal: FiscalChoice) => void;
}

function ReservationPaymentModal({
  reservation,
  unitOptions,
  unitChoices,
  onUnitChoice,
  paymentLines,
  cardFees,
  busy,
  message,
  sellerCode,
  seller,
  onSellerCode,
  onSeller,
  onPaymentLines,
  onClose,
  nfceConfig,
  onConfirm,
}: ReservationPaymentModalProps) {
  const { total, remaining } = reservationAmounts(reservation);
  const pendingUnits = reservation.items.filter((item) => item.isBackorder && item.isSerialized && !item.serialUnitId);
  const unitsReady = pendingUnits.every((item) => unitChoices[item.reservationItemId]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal reservation-modal" role="dialog" aria-modal="true" aria-labelledby="reservation-payment-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Converter reserva</p>
            <h2 id="reservation-payment-title">Finalizar venda</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose} disabled={busy}><X size={20} /></button>
        </div>
        <p className="modal-copy">Cliente: <strong>{reservation.customerName}</strong>. O sinal já recebido será abatido do total.</p>
        <p className="modal-copy">
          Venda de: <strong>{reservation.sellerName ? `${reservation.sellerName} (${reservation.sellerCode})` : 'quem finalizar (reserva sem vendedor)'}</strong>
        </p>
        {pendingUnits.length > 0 && (
          <div className="backorder-units">
            <p className="modal-copy"><strong>Encomenda:</strong> escolha a unidade que chegou para cada item.</p>
            {pendingUnits.map((item) => {
              const options = unitOptions[item.productId] ?? [];
              const takenElsewhere = new Set(Object.entries(unitChoices)
                .filter(([lineId]) => lineId !== item.reservationItemId)
                .map(([, unitId]) => unitId));
              return (
                <label key={item.reservationItemId}>
                  {item.itemName}
                  {options.length === 0 ? (
                    <small className="field-error">Nenhuma unidade disponível: o produto ainda não chegou no estoque.</small>
                  ) : (
                    <select
                      value={unitChoices[item.reservationItemId] ?? ''}
                      onChange={(event) => onUnitChoice(item.reservationItemId, event.target.value)}
                    >
                      <option value="">Selecione o serial</option>
                      {options.filter((unit) => !takenElsewhere.has(unit.serialUnitId)).map((unit) => (
                        <option key={unit.serialUnitId} value={unit.serialUnitId}>
                          {unit.serialNumber}{unit.imei ? ` · IMEI ${unit.imei}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              );
            })}
          </div>
        )}
        <div className="reservation-modal-summary">
          <span>Total da venda</span><strong>{currency.format(total)}</strong>
          <span>Sinal já recebido</span><strong>- {currency.format(reservation.depositAmount)}</strong>
          <span>Saldo a cobrar</span><strong>{currency.format(remaining)}</strong>
        </div>
        {remaining > 0 ? (
          <PaymentLinesEditor
            lines={paymentLines}
            total={remaining}
            totalLabel="Saldo a cobrar"
            busy={busy}
            cardFees={cardFees}
            onChange={onPaymentLines}
          />
        ) : (
          <p className="modal-copy">Não há saldo pendente; a venda será concluída sem nova cobrança.</p>
        )}
        <SellerCodeField
          label="Seu código (quem está finalizando)"
          value={sellerCode}
          seller={seller}
          disabled={busy}
          onValue={onSellerCode}
          onSeller={onSeller}
        />
        <Notice message={message} />
        <div className="modal-actions">
          <button className="text-action" type="button" onClick={onClose} disabled={busy}>Voltar</button>
          <button
            className="primary-action modal-confirm"
            type="button"
            onClick={() => onConfirm('NFCE')}
            disabled={busy || !seller || !unitsReady || !nfceConfig?.configured}
            title={nfceConfig?.configured ? 'Finalizar com NFC-e' : 'NFC-e não configurada para esta loja.'}
          >
            {busy ? 'Processando...' : `NFC-e${nfceConfig?.environment === 'homologacao' ? ' (teste)' : ''}`}
          </button>
          <button className="primary-action modal-confirm" type="button" onClick={() => onConfirm('NAO_FISCAL')} disabled={busy || !seller || !unitsReady}>
            {busy ? 'Processando...' : 'Não Fiscal'}
          </button>
        </div>
      </section>
    </div>
  );
}

interface SellerCodeFieldProps {
  label: string;
  value: string;
  seller: PosSeller | null;
  disabled: boolean;
  onValue: (value: string) => void;
  onSeller: (seller: PosSeller | null) => void;
}

// Campo de 2 digitos que confere o codigo no servidor e mostra o nome do vendedor.
function SellerCodeField({ label, value, seller, disabled, onValue, onSeller }: SellerCodeFieldProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'not-found' | 'error'>('idle');

  useEffect(() => {
    const normalized = normalizeSellerCode(value);
    if (!normalized) {
      onSeller(null);
      setStatus('idle');
      return;
    }
    if (seller?.code === normalized) return;
    let cancelled = false;
    setStatus('loading');
    const timer = window.setTimeout(() => {
      // Sem internet: confere o codigo na copia local dos vendedores da loja.
      (isOffline() ? findOfflineSeller(normalized) : findPosSeller(normalized).catch((error) => {
        if (!isNetworkError(error)) throw error;
        setOffline(true);
        return findOfflineSeller(normalized);
      }))
        .then((found) => {
          if (cancelled) return;
          onSeller(found);
          setStatus(found ? 'idle' : 'not-found');
        })
        .catch(() => {
          if (cancelled) return;
          onSeller(null);
          setStatus('error');
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value]);

  return (
    <label className="seller-code-field">
      {label}
      <input
        inputMode="numeric"
        maxLength={2}
        placeholder="00"
        value={value}
        disabled={disabled}
        onChange={(event) => onValue(event.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
      />
      <small className={seller ? 'seller-code-ok' : status === 'idle' ? '' : 'seller-code-error'}>
        {seller
          ? `Vendedor: ${seller.name}`
          : status === 'loading'
            ? 'Conferindo...'
            : status === 'not-found'
              ? 'Código não encontrado nesta loja (ou vendedor inativo/sem permissão de venda).'
              : status === 'error'
                ? 'Não foi possível conferir o código. Verifique a conexão.'
                : 'Digite os 2 dígitos do seu código.'}
      </small>
    </label>
  );
}

interface SerialUnitModalProps {
  product: PosCatalogItem;
  units: PosSerialUnit[];
  selectedUnitId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (serialUnitId: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

function SerialUnitModal({
  product,
  units,
  selectedUnitId,
  loading,
  error,
  onSelect,
  onClose,
  onConfirm,
}: SerialUnitModalProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal" role="dialog" aria-modal="true" aria-labelledby="serial-unit-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Unidade serializada</p>
            <h2 id="serial-unit-title">{product.name}</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose} disabled={loading}>
            <X size={20} />
          </button>
        </div>
        <p className="modal-copy">Escolha a unidade fisica que sera adicionada ao carrinho.</p>
        {loading ? (
          <p className="empty-state">Buscando unidades disponiveis...</p>
        ) : error ? (
          <p className="notice">{error}</p>
        ) : units.length === 0 ? (
          <p className="empty-state">Nenhuma unidade disponivel em estoque nesta loja.</p>
        ) : (
          <div className="serial-unit-list">
            {units.map((unit) => (
              <label className="serial-unit-option" key={unit.serialUnitId}>
                <input
                  type="radio"
                  name="serial-unit"
                  checked={unit.serialUnitId === selectedUnitId}
                  onChange={() => onSelect(unit.serialUnitId)}
                />
                <span>
                  <strong>{unit.serialNumber}</strong>
                  {unit.imei && <small>IMEI: {unit.imei}</small>}
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="text-action" type="button" onClick={onClose} disabled={loading}>
            Cancelar
          </button>
          <button
            className="primary-action modal-confirm"
            type="button"
            onClick={onConfirm}
            disabled={loading || !selectedUnitId || !!error}
          >
            Adicionar ao carrinho
          </button>
        </div>
      </section>
    </div>
  );
}

interface AdminApprovalModalProps {
  password: string;
  error: string | null;
  busy: boolean;
  cartItems: CartItem[];
  onPassword: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

function AdminApprovalModal({
  password,
  error,
  busy,
  cartItems,
  onPassword,
  onClose,
  onConfirm,
}: AdminApprovalModalProps) {
  const overLimit = cartItems.filter((item) => item.discountPercent > item.maxItemDiscountPercent);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal" role="dialog" aria-modal="true" aria-labelledby="admin-approval-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Autorização do gerente</p>
            <h2 id="admin-approval-title">Desconto acima do limite</h2>
          </div>
          <button className="icon-button" type="button" title="Cancelar" onClick={onClose} disabled={busy}>
            <X size={20} />
          </button>
        </div>
        <p className="modal-copy">
          {overLimit.length === 1
            ? 'Um item deste carrinho excede o limite de desconto.'
            : `${overLimit.length} itens deste carrinho excedem o limite de desconto.`}
          Informe a senha Gerente para liberar a venda.
        </p>
        <ul className="admin-approval-list">
          {overLimit.map((item) => (
            <li key={`overlimit-${item.serialUnit?.serialUnitId ?? `${item.itemType}-${item.id}`}`}>
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.itemType === 'SERVICE' ? 'Servico' : 'Produto'} | Desconto aplicado{' '}
                  {item.discountPercent.toFixed(2)}% (limite {item.maxItemDiscountPercent}%)
                </small>
              </span>
            </li>
          ))}
        </ul>
        <label>
          Senha Gerente
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(event) => onPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <Notice message={error} />
        <div className="modal-actions">
          <button className="text-action" type="button" onClick={onClose} disabled={busy}>Cancelar</button>
          <button
            className="primary-action modal-confirm"
            type="button"
            onClick={onConfirm}
            disabled={busy || !password}
          >
            {busy ? 'Processando...' : 'Liberar e finalizar'}
          </button>
        </div>
      </section>
    </div>
  );
}

function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-panel">{children}</section>
    </main>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <div className="brand-mark">
        <ScanBarcode size={compact ? 22 : 30} />
      </div>
      {!compact && <p className="eyebrow">KanguruERP</p>}
    </div>
  );
}

function Notice({ message }: { message: string | null }) {
  return message ? (
    <p className="notice">
      <CircleAlert size={17} />
      {message}
    </p>
  ) : null;
}

function StoreDetails({ terminal }: { terminal: TerminalContext | null }) {
  return (
    <div className="store-details">
      <strong>{terminal?.tradeName ?? terminal?.displayName}</strong>
      {terminal?.legalName && <span>{terminal.legalName}</span>}
      {terminal?.cnpj && <span>CNPJ: {terminal.cnpj}</span>}
      {terminal?.address && <span>{terminal.address}</span>}
    </div>
  );
}

function CashCount({
  label,
  expected,
  value,
  onChange,
}: {
  label: string;
  expected: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const difference = value - expected;

  return (
    <div className="cash-count">
      <span>
        <strong>{label}</strong>
        <small>Esperado: {currency.format(expected)}</small>
      </span>
      <label>
        Contado
        <ValueInput value={value || null} onValueChange={(next) => onChange(next ?? 0)} />
      </label>
      <strong className={difference === 0 ? '' : difference > 0 ? 'positive' : 'negative'}>
        {difference === 0
          ? 'Sem diferenca'
          : `${difference > 0 ? 'Sobra' : 'Falta'} ${currency.format(Math.abs(difference))}`}
      </strong>
    </div>
  );
}
