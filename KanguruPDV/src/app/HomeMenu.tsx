import { useEffect, useState, type ReactNode } from 'react';
import {
  BanknoteArrowDown,
  BanknoteArrowUp,
  ChartLine,
  ClipboardList,
  FileText,
  Gamepad2,
  Inbox,
  Lock,
  Receipt,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  Wrench,
  X,
} from 'lucide-react';

// Menu inicial em mosaico (2.10, prototipo aprovado): botoes grandes em tons pastel por grupo,
// atalhos de teclado (F1, 1-0) e sub-menus em janela numerada.

export type MenuAction =
  | 'sale' | 'trade-in' | 'trade-phone' | 'work-orders' | 'quotes' | 'reservations' | 'returns' | 'warranty' | 'receipts' | 'new-reservation'
  | 'sangria' | 'suprimento' | 'partial' | 'drawer'
  | 'open-cash' | 'close-cash' | 'reprint-opening' | 'lock'
  | 'product-lookup' | 'today-sales' | 'seller-report'
  | 'comunicador' | 'printer' | 'version';

type Group = 'operacional' | 'consultas' | 'config';

interface Option {
  action: MenuAction;
  label: string;
  description: string;
  disabled?: string | null;
}

interface HomeMenuProps {
  offline: boolean;
  drawerAvailable: boolean;
  cashOpen: boolean;
  version: string | null;
  onAction: (action: MenuAction) => void;
  // Configuracoes pedem a senha Gerente: abre o sub-menu depois de liberar.
  onRequestSettings: (open: () => void) => void;
}

const OFFLINE_BLOCK = 'Indisponível sem internet';

// Linha de explicacao embaixo de cada botao do menu (visual estilo ERP).
const TILE_HINTS: Partial<Record<MenuAction, string>> = {
  sale: 'Bipe o código ou busque o produto',
  reservations: 'Sinal, encomenda e voucher',
  returns: 'Vale-troca, dinheiro ou Pix',
  warranty: 'Por serial, IMEI ou CPF',
  'trade-in': 'Compra de videogames usados',
  'trade-phone': 'Compra de iPhones usados',
  'work-orders': 'Entrada, andamento e entrega',
  quotes: 'Peças, margem, WhatsApp e PDF',
  sangria: 'Retirada da gaveta',
  suprimento: 'Entrada de troco',
  partial: 'Resumo sem fechar',
  receipts: 'Reimprimir, NFC-e e NFS-e',
};

export function HomeMenu({ offline, drawerAvailable, cashOpen, version, onAction, onRequestSettings }: HomeMenuProps) {
  const [group, setGroup] = useState<Group | null>(null);

  const submenus: Record<Group, { title: string; tone: string; options: Option[] }> = {
    operacional: {
      title: 'Operacional',
      tone: 'orange',
      options: [
        { action: 'open-cash', label: 'Abrir caixa', description: 'Imprime o relatório gerencial de abertura', disabled: cashOpen ? 'O caixa já está aberto' : offline ? OFFLINE_BLOCK : null },
        { action: 'close-cash', label: 'Fechar caixa', description: 'Contagem, diferença e relatório de fechamento', disabled: !cashOpen ? 'Nenhum caixa aberto' : offline ? OFFLINE_BLOCK : null },
        { action: 'reprint-opening', label: 'Reimprimir abertura', description: 'Relatório gerencial de abertura deste caixa', disabled: !cashOpen ? 'Nenhum caixa aberto' : null },
        { action: 'lock', label: 'Bloquear terminal', description: 'Pede a senha Gerente para voltar' },
      ],
    },
    consultas: {
      title: 'Consultas',
      tone: 'red',
      options: [
        { action: 'product-lookup', label: 'Consultar produto e estoque', description: 'Preço, estoque desta loja e de outras lojas' },
        { action: 'today-sales', label: 'Vendas do dia', description: 'Lista, reimpressão e NFC-e das vendas de hoje', disabled: offline ? OFFLINE_BLOCK : null },
        { action: 'seller-report', label: 'Vendas por vendedor', description: 'Hoje, no mês e quanto falta para a meta de cada vendedor', disabled: offline ? OFFLINE_BLOCK : null },
      ],
    },
    config: {
      title: 'Configurações',
      tone: 'purple',
      options: [
        { action: 'comunicador', label: 'Comunicador Offline', description: 'Porta do Comunicador da Focus (NFC-e sem internet)' },
        { action: 'printer', label: 'Impressora', description: 'Impressora térmica do cupom (impressão direta e gaveta)' },
        { action: 'version', label: 'Versão e atualização', description: version ? `Versão ${version}` : 'Versão do PDV' },
      ],
    },
  };

  const tiles: { key: string; action: MenuAction; disabled: boolean }[] = [
    { key: '1', action: 'trade-in', disabled: offline || !cashOpen },
    { key: '0', action: 'work-orders', disabled: offline },
    { key: 'o', action: 'quotes', disabled: offline },
    { key: 'p', action: 'trade-phone', disabled: offline || !cashOpen },
    { key: '2', action: 'reservations', disabled: offline || !cashOpen },
    { key: '3', action: 'returns', disabled: offline || !cashOpen },
    { key: '4', action: 'warranty', disabled: offline },
    { key: '5', action: 'receipts', disabled: false },
    { key: '6', action: 'sangria', disabled: !cashOpen },
    { key: '7', action: 'suprimento', disabled: !cashOpen },
    { key: '8', action: 'partial', disabled: offline || !cashOpen },
    { key: '9', action: 'drawer', disabled: !drawerAvailable },
  ];

  function run(action: MenuAction) {
    setGroup(null);
    onAction(action);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (group) {
        if (event.key === 'Escape') setGroup(null);
        const index = Number(event.key) - 1;
        const option = submenus[group].options[index];
        if (option && !option.disabled) run(option.action);
        return;
      }
      // Janela aberta por cima do menu (ex.: Vendas por vendedor): atalhos do menu ficam parados.
      if (document.querySelector('.modal-backdrop')) return;
      if (event.key === 'F1' && cashOpen) {
        event.preventDefault();
        run('sale');
        return;
      }
      const tile = tiles.find((item) => item.key === event.key);
      if (tile && !tile.disabled) run(tile.action);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const tile = (action: MenuAction, tone: string, icon: ReactNode, label: string, shortcut: string, disabled = false, big = false, wide = false) => (
    <button
      type="button"
      className={`menu-tile tone-${tone}${big ? ' is-big' : ''}${wide ? ' is-wide' : ''}`}
      disabled={disabled}
      title={disabled ? (offline ? OFFLINE_BLOCK : 'Abra o caixa primeiro') : undefined}
      onClick={() => run(action)}
    >
      {wide ? (
        <>
          <span className="menu-tile-icon" aria-hidden="true">{icon}</span>
          <span className="menu-tile-text">
            <span className="menu-tile-label">{label}</span>
            {TILE_HINTS[action] && <span className="menu-tile-sub">{TILE_HINTS[action]}</span>}
          </span>
          <kbd>{shortcut}</kbd>
        </>
      ) : (
        <>
          <span className="menu-tile-top"><span className="menu-tile-icon" aria-hidden="true">{icon}</span><kbd>{shortcut}</kbd></span>
          <span className="menu-tile-text">
            <span className="menu-tile-label">{label}</span>
            {TILE_HINTS[action] && <span className="menu-tile-sub">{TILE_HINTS[action]}</span>}
          </span>
        </>
      )}
    </button>
  );


  return (
    <div className="home-menu">
      <section>
        <p className="menu-group-label">Venda</p>
        <div className="menu-grid menu-grid-sale">
          {tile('sale', 'green', <ShoppingCart size={34} strokeWidth={1.8} />, 'Nova venda', 'F1', !cashOpen, true)}
          {tile('reservations', 'green', <ClipboardList size={22} strokeWidth={1.8} />, 'Reservas', '2', offline || !cashOpen)}
          {tile('returns', 'green', <RotateCcw size={22} strokeWidth={1.8} />, 'Trocas e devoluções', '3', offline || !cashOpen)}
          {tile('warranty', 'green', <ShieldCheck size={22} strokeWidth={1.8} />, 'Garantia', '4', offline)}
          {tile('quotes', 'green', <FileText size={22} strokeWidth={1.8} />, 'Orçamento de PC', 'O', offline)}
          {tile('work-orders', 'green', <Wrench size={22} strokeWidth={1.8} />, 'Ordem de serviço', '0', offline)}
          <div className="menu-grid-pair">
            {tile('trade-in', 'green', <Gamepad2 size={22} strokeWidth={1.8} />, 'Troca Gamer', '1', offline || !cashOpen, false, true)}
            {tile('trade-phone', 'green', <Smartphone size={22} strokeWidth={1.8} />, 'Troca Phone', 'P', offline || !cashOpen, false, true)}
          </div>
        </div>
      </section>
      <section className="menu-side">
        <div>
          <p className="menu-group-label">Caixa</p>
          <div className="menu-grid menu-grid-two">
            {tile('sangria', 'blue', <BanknoteArrowDown size={22} strokeWidth={1.8} />, 'Sangria', '6', !cashOpen)}
            {tile('suprimento', 'blue', <BanknoteArrowUp size={22} strokeWidth={1.8} />, 'Suprimento', '7', !cashOpen)}
            {tile('partial', 'blue', <ChartLine size={22} strokeWidth={1.8} />, 'Caixa parcial', '8', offline || !cashOpen)}
            <button type="button" className="menu-tile tone-blue" disabled={!drawerAvailable} title={drawerAvailable ? undefined : 'Escolha a impressora em Configurações › Impressora'} onClick={() => run('drawer')}>
              <span className="menu-tile-top"><span className="menu-tile-icon" aria-hidden="true"><Inbox size={22} strokeWidth={1.8} /></span><kbd>9</kbd></span>
              <span className="menu-tile-text">
                <span className="menu-tile-label">Abrir gaveta</span>
                <span className="menu-tile-sub">{drawerAvailable ? 'Gaveta da impressora' : 'Escolha a impressora'}</span>
              </span>
            </button>
            {tile('receipts', 'blue', <Receipt size={22} strokeWidth={1.8} />, 'Cupons e notas', '5', false, false, true)}
          </div>
        </div>
        <div>
          <p className="menu-group-label">Mais opções</p>
          <div className="menu-grid menu-grid-three">
            <button type="button" className="menu-tile tone-orange is-compact" onClick={() => setGroup('operacional')}>
              <span className="menu-tile-icon" aria-hidden="true"><Lock size={20} strokeWidth={1.8} /></span>
              <span className="menu-tile-label">Operacional</span>
            </button>
            <button type="button" className="menu-tile tone-red is-compact" onClick={() => setGroup('consultas')}>
              <span className="menu-tile-icon" aria-hidden="true"><Search size={20} strokeWidth={1.8} /></span>
              <span className="menu-tile-label">Consultas</span>
            </button>
            <button type="button" className="menu-tile tone-purple is-compact" onClick={() => onRequestSettings(() => setGroup('config'))}>
              <span className="menu-tile-icon" aria-hidden="true"><Settings size={20} strokeWidth={1.8} /></span>
              <span className="menu-tile-label">Configurações</span>
            </button>
          </div>
        </div>
      </section>

      <footer className="menu-footer">
        <span><b>F1</b> Nova venda · <b>1–9</b> atalhos dos botões · <b>Esc</b> voltar</span>
        {version && <span>Versão {version}</span>}
      </footer>

      {group && (
        <div className="modal-backdrop" role="presentation">
          <section className={`submenu tone-${submenus[group].tone}`} role="dialog" aria-modal="true" aria-labelledby="submenu-title">
            <div className="submenu-heading">
              <div>
                <p className="eyebrow">{submenus[group].title}</p>
                <h2 id="submenu-title">Escolha uma opção</h2>
              </div>
              <button className="icon-button" type="button" aria-label="Fechar" onClick={() => setGroup(null)}><X size={20} /></button>
            </div>
            {submenus[group].options.map((option, index) => (
              <button
                key={option.action}
                type="button"
                className="submenu-option"
                disabled={Boolean(option.disabled)}
                onClick={() => run(option.action)}
              >
                <span className="submenu-number">{index + 1}</span>
                <span>
                  {option.label}
                  <small>{option.disabled ?? option.description}</small>
                </span>
              </button>
            ))}
            <p className="submenu-hint">Toque na opção ou digite o número. <b>Esc</b> fecha a janela.</p>
          </section>
        </div>
      )}
    </div>
  );
}
