import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  BanknoteArrowDown,
  BanknoteArrowUp,
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  CreditCard,
  LockKeyhole,
  Minus,
  Plus,
  Printer,
  ScanBarcode,
  Search,
  ShieldCheck,
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
import { getPosSaleReceipt, saleRpc, type PaymentLine, type PaymentMethodKey } from '../services/supabase/sales';
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
  setAdminPassword,
  type PosStoreProfile,
  type TerminalContext,
} from '../services/supabase/terminal';
import {
  closeCashSession,
  getCashClosureSummary,
  getOpenCashSession,
  openCashSession,
  recordCashMovement,
  type CashClosureSummary,
  type CashCounts,
  type CashSession,
} from '../services/supabase/cash-register';

type Screen =
  | 'loading'
  | 'activation'
  | 'set-password'
  | 'unlock'
  | 'cash-open'
  | 'sale'
  | 'reservations'
  | 'new-reservation'
  | 'warranty'
  | 'cash-movement'
  | 'cash-close';
type PaymentMethod = PaymentMethodKey;
type MovementType = 'SANGRIA' | 'SUPRIMENTO';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'Pix',
  CREDITO: 'Credito',
  DEBITO: 'Debito',
  VOUCHER: 'Voucher',
  CREDIARIO: 'Crediario',
};

interface CartItem extends PosCatalogItem {
  quantity: number;
  discountPercent: number;
  serialUnit?: PosSerialUnit;
  // Encomenda: sem estoque agora; so pode ser reservado.
  backorder?: boolean;
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

  const passwordLockedError = message.match(/Administrative password locked until (.+)$/i);
  if (passwordLockedError) {
    return passwordLockedMessage(passwordLockedError[1]);
  }
  if (message.includes('Invalid administrative password')) {
    return 'Senha administrativa incorreta.';
  }
  if (message.includes('Administrative password required')) {
    return 'Informe a senha administrativa para liberar o desconto.';
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
  return `Senha administrativa bloqueada por excesso de tentativas. Tente novamente às ${time}.`;
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
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [cashNumber, setCashNumber] = useState('Caixa 01');
  const [responsibleName, setResponsibleName] = useState('');
  const [openingFloat, setOpeningFloat] = useState('');
  const [movementType, setMovementType] = useState<MovementType>('SANGRIA');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [closure, setClosure] = useState<CashClosureSummary | null>(null);
  const [counts, setCounts] = useState<CashCounts>(emptyCounts);
  const [closureNotes, setClosureNotes] = useState('');
  const [query, setQuery] = useState('');
  const [catalogItems, setCatalogItems] = useState<PosCatalogItem[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [reservations, setReservations] = useState<PosReservation[]>([]);
  const [reservationsLoading, setReservationsLoading] = useState(false);
  const [conversionReservation, setConversionReservation] = useState<PosReservation | null>(null);
  const [conversionPaymentLines, setConversionPaymentLines] = useState<PaymentLine[]>([]);
  const [refundPaymentMethod, setRefundPaymentMethod] = useState<PaymentMethod>('DINHEIRO');
  const [reservationCustomerName, setReservationCustomerName] = useState('');
  const [reservationCustomerPhone, setReservationCustomerPhone] = useState('');
  const [reservationCustomerCpf, setReservationCustomerCpf] = useState('');
  const [storeProfile, setStoreProfile] = useState<PosStoreProfile | null>(null);
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

  async function routeAfterUnlock() {
    const openCash = await getOpenCashSession();
    setCashSession(openCash);
    setScreen(openCash ? 'sale' : 'cash-open');
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
        setScreen(context.needsAdminPassword ? 'set-password' : 'unlock');
      } catch (error) {
        setMessage(errorMessage(error));
        setScreen('activation');
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
      setScreen('set-password');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== passwordConfirmation) {
      setMessage('As senhas nao coincidem.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await setAdminPassword(password);
      setPassword('');
      setPasswordConfirmation('');
      setScreen('unlock');
      setMessage('Senha administrativa definida. Desbloqueie o terminal para continuar.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const context = await requireAdminPassword(password);
      setTerminal(context);
      setPassword('');
      await routeAfterUnlock();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCashOpen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const opened = await openCashSession(cashNumber, responsibleName, valueAsNumber(openingFloat));
      setCashSession(opened);
      setScreen('sale');
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
      await recordCashMovement(
        movementType,
        valueAsNumber(movementAmount),
        movementReason,
        responsibleName
      );
      setMovementAmount('');
      setMovementReason('');
      setScreen('sale');
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
      setCounts({
        cash: summary.expectedCashAmount,
        pix: summary.expectedPixAmount,
        credit: summary.expectedCreditAmount,
        debit: summary.expectedDebitAmount,
        voucher: summary.expectedVoucherAmount,
        creditAccount: summary.expectedCreditAccountAmount,
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
      await requireAdminPassword(password);
      await closeCashSession(responsibleName, counts, closureNotes);
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
      const found = await searchPosItems(trimmedQuery);
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
        const scanned = await findPosSerialUnit(trimmedQuery).catch(() => null);
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
        const availableUnits = await getPosAvailableSerialUnits(product.id, terminal.unitId);
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
      const existing = current.find((item) => item.id === product.id && item.itemType === product.itemType && !item.serialUnit && !item.backorder);
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
        if (item.id !== productId || item.itemType !== itemType) return [item];
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

  async function finalizeSale() {
    if (!cashSession || cart.length === 0) return;
    if (cart.some((item) => item.backorder)) {
      setMessage('Itens de encomenda (sem estoque) só podem ser reservados.');
      return;
    }
    if (!saleSeller) {
      setMessage('Informe o código do vendedor para finalizar a venda.');
      return;
    }
    const resolution = resolvePayments(paymentLines, grossAmount);
    if (resolution.error) {
      setMessage(resolution.error);
      return;
    }
    const needsApproval = cartHasOverLimitDiscount();
    if (needsApproval && !adminApprovalOpen) {
      setAdminApprovalPassword('');
      setAdminApprovalError(null);
      setAdminApprovalOpen(true);
      return;
    }
    setBusy(true);
    setMessage(null);
    setAdminApprovalError(null);
    const saleId = crypto.randomUUID();
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
        })),
        paymentMethod: legacyPaymentMethod(resolution.applied),
        payments: resolution.applied,
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
            ? `Senha administrativa incorreta. Restam ${result.remainingAttempts} tentativa(s) antes do bloqueio temporário.`
            : 'Senha administrativa incorreta. O terminal foi bloqueado temporariamente para senha administrativa.'
        );
        return;
      }
      if (result.status === 'LOCKED') {
        setAdminApprovalPassword('');
        setAdminApprovalError(passwordLockedMessage(result.lockedUntil));
        return;
      }
      setCart([]);
      setCatalogItems([]);
      setQuery('');
      setPaymentLines([]);
      setSaleSellerCode('');
      setSaleSeller(null);
      setSaleCustomer(null);
      setAdminApprovalPassword('');
      setAdminApprovalOpen(false);
      setMessage(
        resolution.changeCents > 0
          ? `Venda registrada com sucesso. Troco: ${currency.format(resolution.changeCents / 100)}.`
          : 'Venda registrada com sucesso.'
      );
      void printReceipt(saleId, resolution.changeCents / 100);
    } catch (error) {
      const text = errorMessage(error);
      setMessage(text);
      if (adminApprovalOpen) setAdminApprovalError(text);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDiscountApproval() {
    if (!adminApprovalPassword) {
      setAdminApprovalError('Digite a senha administrativa para liberar o desconto.');
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

  async function convertReservationToSale(reservation: PosReservation, lines: PaymentLine[]) {
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
        payments: resolution ? resolution.applied : null,
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
      void printReceipt(saleId, resolution ? resolution.changeCents / 100 : 0);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancelReservation(reservation: PosReservation) {
    const refundMethod = reservation.depositAmount > 0 ? refundPaymentMethod : null;
    const confirmation = reservation.depositAmount > 0
      ? `Cancelar a reserva e registrar a devolução manual de ${currency.format(reservation.depositAmount)} por ${refundMethod}? O estorno no adquirente deve ser feito separadamente.`
      : `Cancelar a reserva de ${reservation.customerName}?`;
    if (!window.confirm(confirmation)) return;

    setBusy(true);
    setMessage(null);
    try {
      await cancelPosReservation(reservation.id, refundMethod);
      setReservations(await getPosReservations());
      setMessage('Reserva cancelada e produto liberado.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const grossAmount = cart.reduce((total, item) => total + discountedLineTotal(item), 0);
  const cartHasBackorder = cart.some((item) => item.backorder);
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
        <h1>Definir senha administrativa</h1>
        <p>Esta senha sera solicitada quando o aplicativo for reaberto.</p>
        <form onSubmit={handleSetPassword}>
          <label>
            Nova senha
            <input
              type="password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <label>
            Confirmar senha
            <input
              type="password"
              minLength={8}
              value={passwordConfirmation}
              onChange={(event) => setPasswordConfirmation(event.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <button className="primary-action" disabled={busy}>
            {busy ? 'Salvando...' : 'Definir senha'}
          </button>
        </form>
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
        <p>Informe a senha administrativa para abrir o PDV.</p>
        <form onSubmit={handleUnlock}>
          <label>
            Senha administrativa
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
          <button className="primary-action" disabled={busy}>
            {busy ? 'Registrando...' : 'Confirmar'}
          </button>
        </form>
        <button className="text-action" type="button" onClick={() => setScreen('sale')}>
          Voltar para venda
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
            Senha administrativa
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
            <button className="text-action reservation-back" type="button" onClick={() => setScreen('sale')}>
              Voltar para venda
            </button>
          </div>
        </header>
        <WarrantyPanel />
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
            <label className="reservation-method-label">
              Método da devolução manual
              <select value={refundPaymentMethod} onChange={(event) => setRefundPaymentMethod(event.target.value as PaymentMethod)}>
                <option value="DINHEIRO">Dinheiro</option>
                <option value="PIX">Pix</option>
                <option value="CREDITO">Crédito</option>
                <option value="DEBITO">Débito</option>
              </select>
            </label>
            <button className="primary-action new-reservation-button" type="button" onClick={startNewReservation} disabled={busy}>
              <Plus size={18} /> Nova reserva
            </button>
            <button className="text-action reservation-back" type="button" onClick={() => setScreen('sale')}>
              Voltar para venda
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
                      <button className="reservation-cancel" type="button" disabled={busy} onClick={() => void cancelReservation(reservation)}>
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
            onConfirm={() => void convertReservationToSale(conversionReservation, conversionPaymentLines)}
          />
        )}
      </main>
    );
  }

  return (
    <main className="sale-shell sale-shell-fit">
      <header className="sale-header">
        <div>
          <Brand compact />
          <div>
            <strong>{reservationMode ? 'Nova reserva' : cashSession?.cashNumber}</strong>
            <span>
              {terminal?.tradeName ?? terminal?.unitId} | Aberto por {cashSession?.openedByName}
            </span>
          </div>
        </div>
        {reservationMode ? (
          <div className="header-actions">
            <button className="text-action reservation-back" type="button" onClick={leaveNewReservation} disabled={busy}>
              Voltar para reservas
            </button>
          </div>
        ) : (
          <div className="header-actions">
            <button className="reservation-nav" type="button" onClick={() => void openReservations()} disabled={busy}>
              <ClipboardList size={18} /> Reservas
            </button>
            <button className="reservation-nav" type="button" onClick={() => setScreen('warranty')} disabled={busy}>
              <ShieldCheck size={18} /> Garantia
            </button>
            <button
              className="icon-button"
              type="button"
              title="Registrar sangria"
              onClick={() => {
                setMovementType('SANGRIA');
                setScreen('cash-movement');
              }}
            >
              <BanknoteArrowDown size={20} />
            </button>
            <button
              className="icon-button"
              type="button"
              title="Registrar suprimento"
              onClick={() => {
                setMovementType('SUPRIMENTO');
                setScreen('cash-movement');
              }}
            >
              <BanknoteArrowUp size={20} />
            </button>
            <button className="icon-button" type="button" title="Reimprimir último cupom" onClick={() => void printReceipt(null)} disabled={busy}>
              <Printer size={20} />
            </button>
            <button className="icon-button" type="button" title="Fechar caixa" onClick={() => void openClosing()}>
              <LockKeyhole size={20} />
            </button>
            <span className="operator-badge">
              <CheckCircle2 size={18} />
              Caixa aberto
            </span>
          </div>
        )}
      </header>

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
                Itens acima do limite exigem a senha administrativa na finalização.
              </small>
            )}
          </div>
          <div className="cart-list">
            {cart.length === 0 ? (
              <p className="empty-state">Adicione um produto para iniciar.</p>
            ) : (
              cart.map((item) => (
                <div className="cart-item" key={item.serialUnit?.serialUnitId ?? `${item.itemType}-${item.id}${item.backorder ? '-encomenda' : ''}`}>
                  <div>
                    <strong>{item.name}</strong>
                    {item.backorder && <span className="backorder-tag">Encomenda · sem estoque</span>}
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
                  {item.serialUnit ? (
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
                      <button className="text-action" type="button" onClick={() => setCustomerPickerOpen(true)}>Trocar</button>
                      <button className="text-action" type="button" onClick={() => setSaleCustomer(null)}>Remover</button>
                    </div>
                  </div>
                ) : (
                  <button className="customer-pick" type="button" disabled={busy} onClick={() => setCustomerPickerOpen(true)}>
                    <Search size={16} /> Selecionar ou cadastrar cliente
                  </button>
                )}
              </div>

              <PaymentLinesEditor
                lines={paymentLines}
                total={grossAmount}
                totalLabel="Total da venda"
                busy={busy}
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
                    <strong>{currency.format(grossAmount)}</strong>
                  </div>
                </div>

                <div className="finish-choice">
                  <button
                    className="primary-action finish-button finish-nfce"
                    type="button"
                    disabled
                    title="A emissão de NFC-e entra na próxima etapa (2.8b)."
                  >
                    <CreditCard size={20} />
                    NFC-e
                    <small>em breve</small>
                  </button>
                  <button
                    className="primary-action finish-button"
                    type="button"
                    disabled={busy || cart.length === 0 || !saleSeller || cartHasBackorder}
                    onClick={() => void finalizeSale()}
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

interface PaymentLinesEditorProps {
  lines: PaymentLine[];
  total: number;
  totalLabel: string;
  busy: boolean;
  onChange: (lines: PaymentLine[]) => void;
}

function PaymentLinesEditor({ lines, total, totalLabel, busy, onChange }: PaymentLinesEditorProps) {
  const resolution = resolvePayments(lines, total);
  const totalCents = toCents(total);
  const balanced = resolution.error === null;

  function updateLine(index: number, patch: Partial<PaymentLine>) {
    onChange(lines.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  return (
    <div className="payment-lines">
      <div className="payment-lines-heading">
        <span>Formas de pagamento</span>
        <button
          className="text-action"
          type="button"
          onClick={() => onChange([...lines, { paymentMethod: 'DINHEIRO', amount: 0 }])}
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
          return (
            <div className="payment-line" key={`payment-${index}`}>
              <select
                aria-label={`Forma ${index + 1}`}
                value={line.paymentMethod}
                onChange={(event) => updateLine(index, { paymentMethod: event.target.value as PaymentMethod })}
              >
                {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((method) => (
                  <option key={method} value={method}>
                    {PAYMENT_METHOD_LABELS[method]}
                  </option>
                ))}
              </select>
              <ValueInput
                aria-label={`Valor da forma ${index + 1}`}
                value={Number.isFinite(line.amount) && line.amount ? line.amount : null}
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
                onClick={() => onChange(lines.filter((_, i) => i !== index))}
              >
                <Trash2 size={16} />
              </button>
            </div>
          );
        })
      )}
      <div className="payment-lines-summary">
        <span>{totalLabel}</span>
        <strong>{currency.format(totalCents / 100)}</strong>
        <span>Soma das formas</span>
        <strong className={balanced ? '' : 'negative'}>{currency.format(resolution.sumCents / 100)}</strong>
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
  busy: boolean;
  message: string | null;
  sellerCode: string;
  seller: PosSeller | null;
  onSellerCode: (value: string) => void;
  onSeller: (seller: PosSeller | null) => void;
  onPaymentLines: (lines: PaymentLine[]) => void;
  onClose: () => void;
  onConfirm: () => void;
}

function ReservationPaymentModal({
  reservation,
  unitOptions,
  unitChoices,
  onUnitChoice,
  paymentLines,
  busy,
  message,
  sellerCode,
  seller,
  onSellerCode,
  onSeller,
  onPaymentLines,
  onClose,
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
          <button className="primary-action modal-confirm" type="button" onClick={onConfirm} disabled={busy || !seller || !unitsReady}>
            {busy ? 'Processando...' : 'Confirmar venda'}
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
      findPosSeller(normalized)
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
            <p className="eyebrow">Autorizacao administrativa</p>
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
          Informe a senha administrativa para liberar a venda.
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
          Senha administrativa
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
