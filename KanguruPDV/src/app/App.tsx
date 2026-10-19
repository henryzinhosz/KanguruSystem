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
  ScanBarcode,
  Search,
  Trash2,
  WalletCards,
  X,
} from 'lucide-react';
import { terminalAuth } from '../services/supabase/auth';
import {
  findPosSerialUnit,
  getPosAvailableSerialUnits,
  searchPosItems,
  type PosCatalogItem,
  type PosSerialUnit,
} from '../services/supabase/products';
import { saleRpc, type PaymentLine, type PaymentMethodKey } from '../services/supabase/sales';
import {
  cancelPosReservation,
  createPosReservation,
  getPosReservations,
  type PosReservation,
} from '../services/supabase/reservations';
import { findPosSeller, normalizeSellerCode, type PosSeller } from '../services/supabase/sellers';
import {
  activateTerminal,
  getTerminalContext,
  requireAdminPassword,
  setAdminPassword,
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
    return `Desconto bloqueado. O limite desta loja é ${discountLimitError[1]}%.`;
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
  const [openingFloat, setOpeningFloat] = useState('0,00');
  const [movementType, setMovementType] = useState<MovementType>('SANGRIA');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [closure, setClosure] = useState<CashClosureSummary | null>(null);
  const [counts, setCounts] = useState<CashCounts>(emptyCounts);
  const [closureNotes, setClosureNotes] = useState('');
  const [query, setQuery] = useState('');
  const [catalogItems, setCatalogItems] = useState<PosCatalogItem[]>([]);
  const [maxItemDiscountPercent, setMaxItemDiscountPercent] = useState(0);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [reservations, setReservations] = useState<PosReservation[]>([]);
  const [reservationsLoading, setReservationsLoading] = useState(false);
  const [conversionReservation, setConversionReservation] = useState<PosReservation | null>(null);
  const [conversionPaymentLines, setConversionPaymentLines] = useState<PaymentLine[]>([]);
  const [refundPaymentMethod, setRefundPaymentMethod] = useState<PaymentMethod>('DINHEIRO');
  const [reservationDialogOpen, setReservationDialogOpen] = useState(false);
  const [reservationCustomerName, setReservationCustomerName] = useState('');
  const [reservationCustomerPhone, setReservationCustomerPhone] = useState('');
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
      if (found[0]) setMaxItemDiscountPercent(found[0].maxItemDiscountPercent);
      const normalizedQuery = normalizeSku(trimmedQuery);
      const exactSkuMatches = found.filter((item) => normalizeSku(item.sku) === normalizedQuery);

      if (exactSkuMatches.length === 1) {
        await selectProduct(exactSkuMatches[0]);
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
    setMessage(`${product.itemType === 'SERVICE' ? 'Serviço' : 'Produto'} "${product.name}" adicionado ao carrinho.`);
  }

  function addProduct(product: PosCatalogItem) {
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id && item.itemType === product.itemType && !item.serialUnit);
      if (!existing) return [...current, { ...product, quantity: 1, discountPercent: 0 }];

      if (product.itemType === 'PRODUCT' && existing.quantity >= product.availableQuantity) {
        setMessage('Quantidade maxima disponivel no estoque atingida.');
        return current;
      }

      return current.map((item) =>
        item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
      );
    });
  }

  function changeQuantity(productId: string, itemType: PosCatalogItem['itemType'], change: number) {
    setCart((current) =>
      current.flatMap((item) => {
        if (item.id !== productId || item.itemType !== itemType) return [item];
        const quantity = item.quantity + change;
        if (quantity <= 0) return [];
        return item.itemType === 'PRODUCT' && quantity > item.availableQuantity ? [item] : [{ ...item, quantity }];
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

  // Limite 0% significa "nenhum desconto sem senha" (mesma regra do servidor).
  function cartHasOverLimitDiscount(): boolean {
    return cart.some((item) => item.discountPercent > maxItemDiscountPercent);
  }

  async function finalizeSale() {
    if (!cashSession || cart.length === 0) return;
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
    try {
      const result = await saleRpc.processTransaction({
        saleId: crypto.randomUUID(),
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
        clientCpf: null,
        clientName: null,
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
      setAdminApprovalPassword('');
      setAdminApprovalOpen(false);
      setMessage(
        resolution.changeCents > 0
          ? `Venda registrada com sucesso. Troco: ${currency.format(resolution.changeCents / 100)}.`
          : 'Venda registrada com sucesso.'
      );
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

  async function submitReservation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cashSession || cart.length === 0 || cart.some((item) => item.itemType !== 'PRODUCT')) return;
    if (!reservationSeller) {
      setMessage('Informe o código do vendedor que está fazendo a reserva.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const depositAmount = valueAsNumber(reservationDeposit);
    try {
      await createPosReservation({
        customerName: reservationCustomerName.trim(),
        customerPhone: reservationCustomerPhone.trim(),
        expiresAt: reservationDeadlineIso(reservationExpiresOn),
        depositAmount,
        depositPaymentMethod: depositAmount > 0 ? paymentMethod : null,
        items: cart.map((item) => ({
          productId: item.id,
          quantity: item.quantity,
          discountPercent: item.discountPercent,
          ...(item.serialUnit ? { serialUnitId: item.serialUnit.serialUnitId } : {}),
        })),
        sellerCode: reservationSeller.code,
      });
      setCart([]);
      setCatalogItems([]);
      setQuery('');
      setPaymentLines([]);
      setReservationDialogOpen(false);
      setReservationCustomerName('');
      setReservationCustomerPhone('');
      setReservationDeposit('');
      setReservationSellerCode('');
      setReservationSeller(null);
      setMessage(`Reserva registrada para ${reservationSeller.name}. O produto permanece separado até conversão ou cancelamento.`);
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
    setBusy(true);
    setMessage(null);
    try {
      const result = await saleRpc.processTransaction({
        saleId: crypto.randomUUID(),
        invoiceNumber: `PDV-${Date.now()}`,
        reservationId: reservation.id,
        items: reservation.items.map((item) => ({
          itemType: 'PRODUCT',
          productId: item.productId,
          reservationItemId: item.reservationItemId,
          itemSku: item.itemSku,
          itemName: item.itemName,
          quantity: item.quantity,
          discountPercent: item.discountPercent,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          ...(item.serialNumber ? { serials: [item.serialNumber] } : {}),
        })),
        paymentMethod: resolution
          ? legacyPaymentMethod(resolution.applied)
          : reservation.depositPaymentMethod ?? 'DINHEIRO',
        payments: resolution ? resolution.applied : null,
        grossAmount: total,
        feeAmount: 0,
        netAmount: total,
        clientCpf: null,
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
      setConversionPaymentLines([]);
      setConversionSellerCode('');
      setConversionSeller(null);
      setMessage(
        `Reserva de ${reservation.customerName} convertida em venda${reservation.sellerName ? ` (venda de ${reservation.sellerName})` : ''}. Saldo pago: ${currency.format(remaining)}.`
          + (resolution && resolution.changeCents > 0 ? ` Troco: ${currency.format(resolution.changeCents / 100)}.` : '')
      );
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
            <input
              inputMode="decimal"
              value={openingFloat}
              onChange={(event) => setOpeningFloat(event.target.value)}
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
            <input
              inputMode="decimal"
              value={movementAmount}
              onChange={(event) => setMovementAmount(event.target.value)}
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
                return (
                  <article className={`reservation-entry${reservation.expired ? ' is-expired' : ''}`} key={reservation.id}>
                    <div className="reservation-entry-heading">
                      <div>
                        <h2>{reservation.customerName}</h2>
                        {reservation.customerPhone && <small>{reservation.customerPhone}</small>}
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
                            <small>{item.itemSku}{item.serialNumber ? ` | Série ${item.serialNumber}` : ` | ${item.quantity} un.`}</small>
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
                    <div className="reservation-actions">
                      <button className="primary-action reservation-convert" type="button" disabled={busy} onClick={() => {
                        setConversionPaymentLines([]);
                        setMessage(null);
                        setConversionReservation(reservation);
                      }}>
                        <CreditCard size={18} /> Converter em venda
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
            onClose={() => {
              setConversionReservation(null);
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
    <main className="sale-shell">
      <header className="sale-header">
        <div>
          <Brand compact />
          <div>
            <strong>{cashSession?.cashNumber}</strong>
            <span>
              {terminal?.tradeName ?? terminal?.unitId} | Aberto por {cashSession?.openedByName}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <button className="reservation-nav" type="button" onClick={() => void openReservations()} disabled={busy}>
            <ClipboardList size={18} /> Reservas
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
          <button className="icon-button" type="button" title="Fechar caixa" onClick={() => void openClosing()}>
            <LockKeyhole size={20} />
          </button>
          <span className="operator-badge">
            <CheckCircle2 size={18} />
            Caixa aberto
          </span>
        </div>
      </header>

      <section className="sale-layout">
        <section className="catalog-panel">
          <h1>Nova venda</h1>
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
                className="product-row"
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
                  <small>{item.itemType === 'SERVICE' ? 'Sem estoque físico' : `${item.availableQuantity} em estoque`}</small>
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
            <h2>Carrinho</h2>
            <small>Limite por item: {maxItemDiscountPercent}%</small>
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
                <div className="cart-item" key={item.serialUnit?.serialUnitId ?? `${item.itemType}-${item.id}`}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.itemType === 'SERVICE' ? 'Serviço' : 'Produto'} | {currency.format(item.sellPrice)} cada</small>
                    {item.serialUnit ? (
                      <>
                        <small>Serial: {item.serialUnit.serialNumber}</small>
                        {item.serialUnit.imei && <small>IMEI: {item.serialUnit.imei}</small>}
                      </>
                    ) : null}
                    <label className="cart-discount-label">
                      Desconto (%)
                      <input
                        aria-label={`Desconto percentual de ${item.name}`}
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={item.discountPercent}
                        onChange={(event) => updateItemDiscount(item.id, item.itemType, Number(event.target.value))}
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

          <PaymentLinesEditor
            lines={paymentLines}
            total={grossAmount}
            totalLabel="Total da venda"
            busy={busy}
            onChange={setPaymentLines}
          />

          <div className="total-row">
            <span>Total</span>
            <strong>{currency.format(grossAmount)}</strong>
          </div>

          <SellerCodeField
            label="Código do vendedor"
            value={saleSellerCode}
            seller={saleSeller}
            disabled={busy}
            onValue={setSaleSellerCode}
            onSeller={setSaleSeller}
          />

          <button
            className="reserve-action"
            type="button"
            disabled={busy || cart.length === 0 || cart.some((item) => item.itemType !== 'PRODUCT')}
            onClick={() => setReservationDialogOpen(true)}
          >
            Reservar
          </button>
          {cart.some((item) => item.itemType !== 'PRODUCT') && (
            <small className="reserve-hint">Remova os serviços para reservar os produtos do carrinho.</small>
          )}
          <button
            className="primary-action finish-button"
            type="button"
            disabled={busy || cart.length === 0 || !saleSeller}
            onClick={() => void finalizeSale()}
          >
            <CreditCard size={20} />
            {busy ? 'Processando...' : 'Finalizar venda'}
          </button>
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
          maxItemDiscountPercent={maxItemDiscountPercent}
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
      {reservationDialogOpen && (
        <ReservationModal
          customerName={reservationCustomerName}
          customerPhone={reservationCustomerPhone}
          expiresOn={reservationExpiresOn}
          deposit={reservationDeposit}
          paymentMethod={paymentMethod}
          total={grossAmount}
          busy={busy}
          onCustomerName={setReservationCustomerName}
          onCustomerPhone={setReservationCustomerPhone}
          onExpiresOn={setReservationExpiresOn}
          onDeposit={setReservationDeposit}
          onPaymentMethod={(value) => setPaymentMethod(value as PaymentMethod)}
          sellerCode={reservationSellerCode}
          seller={reservationSeller}
          onSellerCode={setReservationSellerCode}
          onSeller={setReservationSeller}
          onClose={() => setReservationDialogOpen(false)}
          onSubmit={(event) => void submitReservation(event)}
        />
      )}
    </main>
  );
}

interface ReservationModalProps {
  customerName: string;
  customerPhone: string;
  expiresOn: string;
  deposit: string;
  paymentMethod: PaymentMethod;
  total: number;
  busy: boolean;
  onCustomerName: (value: string) => void;
  onCustomerPhone: (value: string) => void;
  onExpiresOn: (value: string) => void;
  onDeposit: (value: string) => void;
  onPaymentMethod: (value: PaymentMethod) => void;
  sellerCode: string;
  seller: PosSeller | null;
  onSellerCode: (value: string) => void;
  onSeller: (seller: PosSeller | null) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function ReservationModal({
  customerName,
  customerPhone,
  expiresOn,
  deposit,
  paymentMethod,
  total,
  busy,
  onCustomerName,
  onCustomerPhone,
  onExpiresOn,
  onDeposit,
  onPaymentMethod,
  sellerCode,
  seller,
  onSellerCode,
  onSeller,
  onClose,
  onSubmit,
}: ReservationModalProps) {
  const depositAmount = valueAsNumber(deposit);
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal reservation-modal" role="dialog" aria-modal="true" aria-labelledby="reservation-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Separar produto</p>
            <h2 id="reservation-title">Nova reserva</h2>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose} disabled={busy}><X size={20} /></button>
        </div>
        <p className="modal-copy">O produto ficará indisponível para outras vendas até conversão ou cancelamento.</p>
        <form onSubmit={onSubmit}>
          <label>
            Nome do cliente
            <input autoFocus required maxLength={160} value={customerName} onChange={(event) => onCustomerName(event.target.value)} />
          </label>
          <label>
            Telefone (opcional)
            <input type="tel" maxLength={40} value={customerPhone} onChange={(event) => onCustomerPhone(event.target.value)} />
          </label>
          <label>
            Data limite
            <input type="date" required min={localDateInputValue()} value={expiresOn} onChange={(event) => onExpiresOn(event.target.value)} />
          </label>
          <label>
            Sinal / depósito (opcional)
            <input type="number" min="0" max={total} step="0.01" value={deposit} onChange={(event) => onDeposit(event.target.value)} />
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
          <SellerCodeField
            label="Código do vendedor (fica com a venda)"
            value={sellerCode}
            seller={seller}
            disabled={busy}
            onValue={onSellerCode}
            onSeller={onSeller}
          />
          <div className="reservation-modal-summary">
            <span>Total reservado</span><strong>{currency.format(total)}</strong>
            <span>Sinal</span><strong>{currency.format(depositAmount)}</strong>
            <span>Saldo na conversão</span><strong>{currency.format(Math.max(0, total - depositAmount))}</strong>
          </div>
          <div className="modal-actions">
            <button className="text-action" type="button" onClick={onClose} disabled={busy}>Voltar</button>
            <button className="primary-action modal-confirm" type="submit" disabled={busy || depositAmount > total || !seller}>
              {busy ? 'Registrando...' : 'Confirmar reserva'}
            </button>
          </div>
        </form>
      </section>
    </div>
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
              <input
                aria-label={`Valor da forma ${index + 1}`}
                type="number"
                min="0"
                step="0.01"
                value={Number.isFinite(line.amount) ? line.amount : 0}
                onChange={(event) => updateLine(index, { amount: Number(event.target.value) })}
                onFocus={(event) => {
                  // Pre-preenche com o saldo restante quando o campo esta zerado.
                  if (!line.amount && totalCents > 0) {
                    const suggested = Math.max(0, totalCents - otherLinesCents) / 100;
                    if (suggested > 0) {
                      updateLine(index, { amount: suggested });
                      event.currentTarget.value = String(suggested);
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
          <button className="primary-action modal-confirm" type="button" onClick={onConfirm} disabled={busy || !seller}>
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
  maxItemDiscountPercent: number;
  onPassword: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

function AdminApprovalModal({
  password,
  error,
  busy,
  cartItems,
  maxItemDiscountPercent,
  onPassword,
  onClose,
  onConfirm,
}: AdminApprovalModalProps) {
  const overLimit = cartItems.filter((item) => item.discountPercent > maxItemDiscountPercent);
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
            ? 'Um item deste carrinho excede o limite de desconto da loja.'
            : `${overLimit.length} itens deste carrinho excedem o limite de desconto da loja.`}
          Informe a senha administrativa para liberar a venda.
        </p>
        <ul className="admin-approval-list">
          {overLimit.map((item) => (
            <li key={`overlimit-${item.serialUnit?.serialUnitId ?? `${item.itemType}-${item.id}`}`}>
              <span>
                <strong>{item.name}</strong>
                <small>
                  {item.itemType === 'SERVICE' ? 'Servico' : 'Produto'} | Desconto aplicado{' '}
                  {item.discountPercent.toFixed(2)}% (limite {maxItemDiscountPercent}%)
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
        <input
          inputMode="decimal"
          value={value.toFixed(2).replace('.', ',')}
          onChange={(event) => onChange(valueAsNumber(event.target.value))}
        />
      </label>
      <strong className={difference === 0 ? '' : difference > 0 ? 'positive' : 'negative'}>
        {difference === 0
          ? 'Sem diferenca'
          : `${difference > 0 ? 'Sobra' : 'Falta'} ${currency.format(Math.abs(difference))}`}
      </strong>
    </div>
  );
}
