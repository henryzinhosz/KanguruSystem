import { AlertTriangle, CalendarClock, ChevronRight, Package, ReceiptText, Wallet, WifiOff, Wrench, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ErpAlert, ErpAlertKind } from '../db/insights';

// "Precisa de atenção" (desenho aprovado em 2026-11-03): pendencias das lojas num lugar so.
// Cada alerta fica ate o problema ser resolvido (sem "dispensar").

export type AttentionTarget = 'estoque' | 'servicos' | 'financeiro' | null;

const KIND_INFO: Record<ErpAlertKind, { label: string; icon: LucideIcon; tone: string; target: AttentionTarget; hint?: string }> = {
  ESTOQUE: { label: 'Estoque baixo', icon: Package, tone: 'text-rose-600 bg-rose-50 border-rose-100', target: 'estoque' },
  OS_ATRASADA: { label: 'OS atrasadas', icon: Wrench, tone: 'text-rose-600 bg-rose-50 border-rose-100', target: 'servicos' },
  NOTA: { label: 'Notas com problema', icon: ReceiptText, tone: 'text-rose-600 bg-rose-50 border-rose-100', target: 'financeiro', hint: 'Corrija em Cupons e notas, no PDV' },
  CAIXA: { label: 'Caixa com diferença', icon: Wallet, tone: 'text-rose-600 bg-rose-50 border-rose-100', target: 'financeiro' },
  OS_PARADA: { label: 'OS prontas e não retiradas', icon: Wrench, tone: 'text-amber-600 bg-amber-50 border-amber-100', target: 'servicos' },
  RESERVA: { label: 'Reservas vencidas', icon: CalendarClock, tone: 'text-amber-600 bg-amber-50 border-amber-100', target: null, hint: 'Converta ou cancele na tela Reservas do PDV' },
  OFFLINE: { label: 'Vendas sem internet com divergência', icon: WifiOff, tone: 'text-amber-600 bg-amber-50 border-amber-100', target: 'financeiro' },
};

const KIND_ORDER: ErpAlertKind[] = ['ESTOQUE', 'OS_ATRASADA', 'NOTA', 'CAIXA', 'OS_PARADA', 'RESERVA', 'OFFLINE'];

interface AttentionPanelProps {
  alerts: ErpAlert[];
  storeName: (unitId: string) => string;
  onNavigate: (target: Exclude<AttentionTarget, null>) => void;
  loading?: boolean;
  error?: string;
}

export default function AttentionPanel({ alerts, storeName, onNavigate, loading, error }: AttentionPanelProps) {
  const groups = KIND_ORDER
    .map(kind => ({ kind, items: alerts.filter(alert => alert.kind === kind) }))
    .filter(group => group.items.length > 0);

  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden text-xs">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <AlertTriangle className={`w-4 h-4 ${alerts.length ? 'text-amber-500' : 'text-emerald-500'}`} />
        <h4 className="text-sm font-bold text-slate-900">Precisa de atenção</h4>
        <span className="text-slate-500">{loading ? 'carregando...' : alerts.length ? `${alerts.length} item(ns)` : 'tudo em ordem'}</span>
      </div>
      {error && <p className="m-3 text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</p>}
      {!loading && alerts.length === 0 && !error && <p className="p-4 text-slate-400">Nenhuma pendência nas suas lojas.</p>}
      <div className="divide-y divide-slate-100">
        {groups.map(({ kind, items }) => {
          const info = KIND_INFO[kind];
          const Icon = info.icon;
          return (
            <details key={kind} className="group" open={groups.length <= 2}>
              <summary className="px-4 py-3 flex items-center gap-3 cursor-pointer list-none hover:bg-slate-50">
                <span className={`p-2 rounded-lg border ${info.tone}`}><Icon className="w-4 h-4" /></span>
                <span className="flex-1 min-w-0">
                  <strong className="text-slate-900">{info.label}</strong>
                  <span className="block text-slate-500">{items.length} item(ns){info.hint ? ` · ${info.hint}` : ''}</span>
                </span>
                {info.target && (
                  <button type="button" onClick={event => { event.preventDefault(); onNavigate(info.target!); }} className="inline-flex items-center gap-1 font-bold text-blue-700 hover:underline">
                    Ver<ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </summary>
              <ul className="pb-2">
                {items.slice(0, 30).map((alert, index) => (
                  <li key={`${alert.ref}-${index}`} className="pl-[60px] pr-4 py-1.5">
                    <span className="font-semibold text-slate-800">{alert.title}</span>
                    <span className="block text-slate-500">{[storeName(alert.unitId), alert.detail].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
                {items.length > 30 && <li className="pl-[60px] pr-4 py-1.5 text-slate-400">e mais {items.length - 30}...</li>}
              </ul>
            </details>
          );
        })}
      </div>
    </section>
  );
}

// Janela aberta pelo sino do topo.
export function AttentionDrawer({ onClose, ...props }: AttentionPanelProps & { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] bg-slate-900/40 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-md h-full bg-slate-50 shadow-xl overflow-y-auto p-4 space-y-3" onClick={event => event.stopPropagation()}>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} aria-label="Fechar" className="p-1.5 rounded-lg hover:bg-slate-200"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        <AttentionPanel {...props} onNavigate={target => { props.onNavigate(target); onClose(); }} />
      </div>
    </div>
  );
}
