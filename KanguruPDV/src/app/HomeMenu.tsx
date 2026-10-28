import { useEffect, useState, type ReactNode } from 'react';
import {
  BanknoteArrowDown,
  BanknoteArrowUp,
  ChartLine,
  ClipboardList,
  Inbox,
  Lock,
  Receipt,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  X,
} from 'lucide-react';

// Menu inicial em mosaico (2.10, prototipo aprovado): botoes grandes em tons pastel por grupo,
// atalhos de teclado (F1, 1-0) e sub-menus em janela numerada.

export type MenuAction =
  | 'sale' | 'reservations' | 'returns' | 'warranty' | 'receipts' | 'new-reservation'
  | 'sangria' | 'suprimento' | 'partial' | 'drawer'
  | 'open-cash' | 'close-cash' | 'reprint-opening' | 'lock'
  | 'product-lookup' | 'today-sales'
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
  cashOpen: boolean;
  version: string | null;
  onAction: (action: MenuAction) => void;
}

const OFFLINE_BLOCK = 'Indisponível sem internet';

export function HomeMenu({ offline, cashOpen, version, onAction }: HomeMenuProps) {
  const [group, setGroup] = useState<Group | null>(null);

  const submenus: Record<Group, { title: string; tone: string; options: Option[] }> = {
    operacional: {
      title: 'Operacional',
      tone: 'orange',
      options: [
        { action: 'open-cash', label: 'Abrir caixa', description: 'Imprime o relatório gerencial de abertura', disabled: cashOpen ? 'O caixa já está aberto' : offline ? OFFLINE_BLOCK : null },
        { action: 'close-cash', label: 'Fechar caixa', description: 'Contagem, diferença e relatório de fechamento', disabled: !cashOpen ? 'Nenhum caixa aberto' : offline ? OFFLINE_BLOCK : null },
        { action: 'reprint-opening', label: 'Reimprimir abertura', description: 'Relatório gerencial de abertura deste caixa', disabled: !cashOpen ? 'Nenhum caixa aberto' : null },
        { action: 'lock', label: 'Bloquear terminal', description: 'Pede a senha administrativa para voltar' },
      ],
    },
    consultas: {
      title: 'Consultas',
      tone: 'red',
      options: [
        { action: 'product-lookup', label: 'Consultar produto e estoque', description: 'Preço, estoque desta loja e de outras lojas' },
        { action: 'today-sales', label: 'Vendas do dia', description: 'Lista, reimpressão e NFC-e das vendas de hoje', disabled: offline ? OFFLINE_BLOCK : null },
      ],
    },
    config: {
      title: 'Configurações',
      tone: 'purple',
      options: [
        { action: 'comunicador', label: 'Comunicador Offline', description: 'Porta do Comunicador da Focus (NFC-e sem internet)' },
        { action: 'printer', label: 'Impressora', description: 'Impressão direta na Epson (em breve)', disabled: 'Em breve' },
        { action: 'version', label: 'Versão e atualização', description: version ? `Versão ${version}` : 'Versão do PDV' },
      ],
    },
  };

  const tiles: { key: string; action: MenuAction; disabled: boolean }[] = [
    { key: '2', action: 'reservations', disabled: offline || !cashOpen },
    { key: '3', action: 'returns', disabled: offline || !cashOpen },
    { key: '4', action: 'warranty', disabled: offline },
    { key: '5', action: 'receipts', disabled: false },
    { key: '6', action: 'sangria', disabled: !cashOpen },
    { key: '7', action: 'suprimento', disabled: !cashOpen },
    { key: '8', action: 'partial', disabled: offline || !cashOpen },
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

  const tile = (action: MenuAction, tone: string, icon: ReactNode, label: string, shortcut: string, disabled = false, big = false) => (
    <button
      type="button"
      className={`menu-tile tone-${tone}${big ? ' is-big' : ''}`}
      disabled={disabled}
      title={disabled ? (offline ? OFFLINE_BLOCK : 'Abra o caixa primeiro') : undefined}
      onClick={() => run(action)}
    >
      <span className="menu-tile-top">{icon}<kbd>{shortcut}</kbd></span>
      <span className="menu-tile-label">{label}</span>
      {big && <span className="menu-tile-sub">Bipe o código ou busque o produto</span>}
    </button>
  );

  return (
    <div className="home-menu">
      <section>
        <p className="menu-group-label">Venda</p>
        <div className="menu-grid menu-grid-sale">
          {tile('sale', 'green', <ShoppingCart size={44} strokeWidth={1.8} />, 'Nova venda', 'F1', !cashOpen, true)}
          {tile('reservations', 'green', <ClipboardList size={28} strokeWidth={1.8} />, 'Reservas', '2', offline || !cashOpen)}
          {tile('returns', 'green', <RotateCcw size={28} strokeWidth={1.8} />, 'Trocas e devoluções', '3', offline || !cashOpen)}
          {tile('warranty', 'green', <ShieldCheck size={28} strokeWidth={1.8} />, 'Garantia', '4', offline)}
          {tile('receipts', 'green', <Receipt size={28} strokeWidth={1.8} />, 'Cupons e notas', '5')}
        </div>
      </section>
      <section className="menu-side">
        <div>
          <p className="menu-group-label">Caixa</p>
          <div className="menu-grid menu-grid-two">
            {tile('sangria', 'blue', <BanknoteArrowDown size={26} strokeWidth={1.8} />, 'Sangria', '6', !cashOpen)}
            {tile('suprimento', 'blue', <BanknoteArrowUp size={26} strokeWidth={1.8} />, 'Suprimento', '7', !cashOpen)}
            {tile('partial', 'blue', <ChartLine size={26} strokeWidth={1.8} />, 'Caixa parcial', '8', offline || !cashOpen)}
            <button type="button" className="menu-tile tone-blue" disabled title="Depende da impressão direta na impressora (em breve)">
              <span className="menu-tile-top"><Inbox size={26} strokeWidth={1.8} /><kbd>9</kbd></span>
              <span className="menu-tile-label">Abrir gaveta</span>
              <span className="menu-tile-sub">em breve</span>
            </button>
          </div>
        </div>
        <div>
          <p className="menu-group-label">Mais opções</p>
          <div className="menu-grid menu-grid-three">
            <button type="button" className="menu-tile tone-orange is-compact" onClick={() => setGroup('operacional')}>
              <Lock size={26} strokeWidth={1.8} aria-hidden="true" />
              <span className="menu-tile-label">Operacional</span>
            </button>
            <button type="button" className="menu-tile tone-red is-compact" onClick={() => setGroup('consultas')}>
              <Search size={26} strokeWidth={1.8} aria-hidden="true" />
              <span className="menu-tile-label">Consultas</span>
            </button>
            <button type="button" className="menu-tile tone-purple is-compact" onClick={() => setGroup('config')}>
              <Settings size={26} strokeWidth={1.8} aria-hidden="true" />
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
