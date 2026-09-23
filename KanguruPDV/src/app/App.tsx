import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  BanknoteArrowDown,
  BanknoteArrowUp,
  CheckCircle2,
  CircleAlert,
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
  getPosAvailableSerialUnits,
  searchPosProducts,
  type PosProduct,
  type PosSerialUnit,
} from '../services/supabase/products';
import { saleRpc } from '../services/supabase/sales';
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
  | 'cash-movement'
  | 'cash-close';
type PaymentMethod = 'DINHEIRO' | 'PIX' | 'CREDITO' | 'DEBITO';
type MovementType = 'SANGRIA' | 'SUPRIMENTO';

interface CartItem extends PosProduct {
  quantity: number;
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

  return message.includes('Anonymous sign-ins are disabled')
    ? 'Habilite Anonymous Sign-Ins em Authentication > Providers no projeto Supabase antes de ativar terminais.'
    : message;
}

function valueAsNumber(value: string): number {
  return Number(value.replace(',', '.')) || 0;
}

function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}

function warrantyLabel(months: number | null): string {
  if (months === null) return 'Garantia nao cadastrada';
  if (months <= 0) return 'Sem garantia';
  return `${months} ${months === 1 ? 'mes' : 'meses'} de garantia`;
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
  const [products, setProducts] = useState<PosProduct[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [serialProduct, setSerialProduct] = useState<PosProduct | null>(null);
  const [serialUnits, setSerialUnits] = useState<PosSerialUnit[]>([]);
  const [selectedSerialUnitId, setSelectedSerialUnitId] = useState<string | null>(null);
  const [serialUnitsLoading, setSerialUnitsLoading] = useState(false);
  const [serialUnitsError, setSerialUnitsError] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('DINHEIRO');
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
      setProducts([]);
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const found = await searchPosProducts(trimmedQuery);
      const normalizedQuery = normalizeSku(trimmedQuery);
      const exactSkuMatches = found.filter((product) => normalizeSku(product.sku) === normalizedQuery);

      if (exactSkuMatches.length === 1) {
        await selectProduct(exactSkuMatches[0]);
        return;
      }

      if (exactSkuMatches.length > 1) {
        setMessage(
          `Foram encontrados ${exactSkuMatches.length} produtos com o SKU "${trimmedQuery}". Selecione manualmente na lista para evitar ambiguidade.`
        );
      }

      setProducts(found);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectProduct(product: PosProduct) {
    if (product.requiresUnitSelection) {
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
    setProducts([]);
    setQuery('');
    setMessage(`Produto "${product.name}" adicionado ao carrinho.`);
  }

  function addProduct(product: PosProduct) {
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id);
      if (!existing) return [...current, { ...product, quantity: 1 }];

      if (existing.quantity >= product.availableQuantity) {
        setMessage('Quantidade maxima disponivel no estoque atingida.');
        return current;
      }

      return current.map((item) =>
        item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
      );
    });
  }

  function changeQuantity(productId: string, change: number) {
    setCart((current) =>
      current.flatMap((item) => {
        if (item.id !== productId) return [item];
        const quantity = item.quantity + change;
        if (quantity <= 0) return [];
        return quantity > item.availableQuantity ? [item] : [{ ...item, quantity }];
      })
    );
  }

  function closeSerialUnitModal() {
    if (serialUnitsLoading) return;
    setSerialProduct(null);
    setSerialUnits([]);
    setSelectedSerialUnitId(null);
    setSerialUnitsError(null);
  }

  function addSelectedSerialUnit() {
    if (!serialProduct || !selectedSerialUnitId) return;
    const serialUnit = serialUnits.find((unit) => unit.serialUnitId === selectedSerialUnitId);
    if (!serialUnit) return;

    setCart((current) => {
      if (current.some((item) => item.serialUnit?.serialUnitId === serialUnit.serialUnitId)) {
        setMessage('Esta unidade serializada ja esta no carrinho.');
        return current;
      }
      return [...current, { ...serialProduct, quantity: 1, serialUnit }];
    });
    setProducts([]);
    setQuery('');
    setMessage(`Unidade ${serialUnit.serialNumber} adicionada ao carrinho.`);
    closeSerialUnitModal();
  }

  async function finalizeSale() {
    if (!cashSession || cart.length === 0) return;
    setBusy(true);
    setMessage(null);
    const grossAmount = cart.reduce((total, item) => total + item.sellPrice * item.quantity, 0);
    try {
      await saleRpc.processTransaction({
        saleId: crypto.randomUUID(),
        invoiceNumber: `PDV-${Date.now()}`,
        items: cart.map((item) => ({
          productId: item.id,
          quantity: item.quantity,
          ...(item.serialUnit
            ? {
                serials: [item.serialUnit.serialNumber],
              }
            : {}),
        })),
        paymentMethod,
        grossAmount,
        feeAmount: 0,
        netAmount: grossAmount,
        clientCpf: null,
        clientName: null,
        timestamp: new Date().toISOString(),
        status: 'CONCLUIDA',
        requiresApproval: false,
      });
      setCart([]);
      setProducts([]);
      setQuery('');
      setMessage('Venda registrada com sucesso.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const grossAmount = cart.reduce((total, item) => total + item.sellPrice * item.quantity, 0);

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
              placeholder="Buscar por nome, marca ou SKU"
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
            {products.map((product) => (
              <button
                className="product-row"
                type="button"
                key={product.id}
                onClick={() => void selectProduct(product)}
              >
                <span>
                  <strong>{product.name}</strong>
                  <small>
                    {product.sku}
                    {product.brand ? ` | ${product.brand}` : ''}
                  </small>
                  <small>{warrantyLabel(product.warrantyMonths)}</small>
                  {product.requiresUnitSelection && <small>Serializado: selecione a unidade.</small>}
                </span>
                <span>
                  <strong>{currency.format(product.sellPrice)}</strong>
                  <small>{product.availableQuantity} em estoque</small>
                </span>
              </button>
            ))}

            {query && products.length === 0 && !busy && (
              <p className="empty-state">Nenhum produto encontrado.</p>
            )}
          </div>
        </section>

        <aside className="cart-panel">
          <h2>Carrinho</h2>
          <div className="cart-list">
            {cart.length === 0 ? (
              <p className="empty-state">Adicione um produto para iniciar.</p>
            ) : (
              cart.map((item) => (
                <div className="cart-item" key={item.serialUnit?.serialUnitId ?? item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    {item.serialUnit ? (
                      <>
                        <small>Serial: {item.serialUnit.serialNumber}</small>
                        {item.serialUnit.imei && <small>IMEI: {item.serialUnit.imei}</small>}
                      </>
                    ) : (
                      <small>{currency.format(item.sellPrice)} cada</small>
                    )}
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
                        onClick={() => changeQuantity(item.id, -1)}
                        title="Remover uma unidade"
                      >
                        <Minus size={16} />
                      </button>
                      <span>{item.quantity}</span>
                      <button
                        type="button"
                        onClick={() => changeQuantity(item.id, 1)}
                        title="Adicionar uma unidade"
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  )}
                  <strong>{currency.format(item.sellPrice * item.quantity)}</strong>
                </div>
              ))
            )}
          </div>

          <label className="payment-label">
            Pagamento
            <select
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
            >
              <option value="DINHEIRO">Dinheiro</option>
              <option value="PIX">Pix</option>
              <option value="CREDITO">Credito</option>
              <option value="DEBITO">Debito</option>
            </select>
          </label>

          <div className="total-row">
            <span>Total</span>
            <strong>{currency.format(grossAmount)}</strong>
          </div>

          <button
            className="primary-action finish-button"
            type="button"
            disabled={busy || cart.length === 0}
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
    </main>
  );
}

interface SerialUnitModalProps {
  product: PosProduct;
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
