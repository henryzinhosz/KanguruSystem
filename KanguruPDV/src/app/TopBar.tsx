import { useEffect, useState, type ReactNode } from 'react';
import { useOfflineState } from '../offline/offline';

// Barra superior fixa (2.10): loja, PDV, data do caixa, abertura, operador, conexao e hora.

interface TopBarProps {
  storeName: string;
  subtitle: string;
  cashNumber: string | null;
  cashDate: string | null;
  sessionNumber: number | null;
  operator: string | null;
  leading?: ReactNode;
}

export function TopBar({ storeName, subtitle, cashNumber, cashDate, sessionNumber, operator, leading }: TopBarProps) {
  const { offline, pending } = useOfflineState();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <header className="top-bar">
      <div className="top-bar-identity">
        {leading ?? (
          <span className="top-bar-logo" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M8 7v10" /><path d="M12 7v10" /><path d="M16 7v10" /></svg>
          </span>
        )}
        <div>
          <strong>{storeName}</strong>
          <span>{subtitle}</span>
        </div>
      </div>
      <div className="top-bar-info">
        {cashNumber && <span><small>PDV</small> <b>{cashNumber}</b></span>}
        {cashDate && <span><small>Caixa de</small> <b>{cashDate}</b></span>}
        {sessionNumber != null && <span><small>Abertura nº</small> <b>{String(sessionNumber).padStart(2, '0')}</b></span>}
        {operator && <span><small>Operador</small> <b>{operator}</b></span>}
        <span className={`top-bar-status${offline ? ' is-offline' : ''}`}>
          <i aria-hidden="true" />
          {offline ? 'Offline' : 'Online'}
          {pending > 0 ? ` · ${pending} a enviar` : ''}
        </span>
        <span className="top-bar-clock">{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </header>
  );
}
