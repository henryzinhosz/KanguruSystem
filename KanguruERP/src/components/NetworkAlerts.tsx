import { FormEvent, useEffect, useState } from 'react';
import { BadgeDollarSign, ChevronRight, Clock, ReceiptText, RefreshCw, Settings2, Store, Target, Wallet, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatMoney } from '../db/finance';
import {
  getNetworkAlerts,
  getNetworkAlertSettings,
  saveNetworkAlertSettings,
  type NetworkAlert,
  type NetworkAlertKind,
  type NetworkAlertSettings,
} from '../db/network';
import ValueInput from './ValueInput';

// Painel da Rede › Alertas (desenho aprovado em 2026-11-03). Limites ajustaveis pelo dono da rede.

const KIND_INFO: Record<NetworkAlertKind, { label: string; icon: LucideIcon; tone: string }> = {
  SEM_VENDA: { label: 'Lojas sem vender', icon: Store, tone: 'text-rose-600 bg-rose-50 border-rose-100' },
  CAIXA_DIFERENCA: { label: 'Caixa com diferença grande', icon: Wallet, tone: 'text-rose-600 bg-rose-50 border-rose-100' },
  NOTAS: { label: 'Notas com problema', icon: ReceiptText, tone: 'text-rose-600 bg-rose-50 border-rose-100' },
  CAIXA_ABERTO: { label: 'Caixa aberto há muito tempo', icon: Clock, tone: 'text-amber-600 bg-amber-50 border-amber-100' },
  META: { label: 'Lojas abaixo da meta', icon: Target, tone: 'text-amber-600 bg-amber-50 border-amber-100' },
  ASSINATURA: { label: 'Assinatura do sistema', icon: BadgeDollarSign, tone: 'text-amber-600 bg-amber-50 border-amber-100' },
};
const KIND_ORDER: NetworkAlertKind[] = ['SEM_VENDA', 'CAIXA_DIFERENCA', 'NOTAS', 'CAIXA_ABERTO', 'META', 'ASSINATURA'];

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'Erro ao carregar.';

export default function NetworkAlerts({ isOwner, onOpenFranchise, onCountChange }: {
  isOwner: boolean;
  onOpenFranchise: (franchiseName: string) => void;
  onCountChange?: (count: number) => void;
}) {
  const [alerts, setAlerts] = useState<NetworkAlert[]>([]);
  const [settings, setSettings] = useState<NetworkAlertSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [rows, current] = await Promise.all([getNetworkAlerts(), getNetworkAlertSettings()]);
      setAlerts(rows);
      setSettings(current);
      onCountChange?.(rows.length);
    } catch (loadError) {
      setError(`Não foi possível carregar os alertas: ${errorText(loadError)}. Confira se a migration 20261119 foi aplicada.`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const groups = KIND_ORDER.map(kind => ({ kind, items: alerts.filter(alert => alert.kind === kind) })).filter(group => group.items.length > 0);

  return (
    <div className="space-y-4 text-xs">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs p-3 flex flex-wrap items-center gap-2">
        <span className="text-slate-500">
          {settings
            ? `Limites: sem vender há ${settings.noSaleDays} dia(s) · diferença de caixa acima de ${formatMoney(settings.cashDifference)} · caixa aberto há mais de ${settings.cashOpenHours} h · projeção abaixo de ${settings.goalMinPercent}% da meta`
            : 'Carregando limites...'}
        </span>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={() => void load()} disabled={loading} className="h-10 w-10 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-50" title="Atualizar" aria-label="Atualizar">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {isOwner && settings && (
            <button type="button" onClick={() => setEditing(true)} className="h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold inline-flex items-center gap-1.5"><Settings2 className="w-4 h-4" />Configurações</button>
          )}
        </div>
      </div>

      {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
      {!loading && !error && alerts.length === 0 && <p className="bg-white border border-slate-200 rounded-xl p-6 text-center text-emerald-700 font-bold">Nenhum alerta na rede. Tudo em ordem.</p>}

      {groups.map(({ kind, items }) => {
        const info = KIND_INFO[kind];
        const Icon = info.icon;
        return (
          <section key={kind} className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-3">
              <span className={`p-2 rounded-lg border ${info.tone}`}><Icon className="w-4 h-4" /></span>
              <h4 className="text-sm font-bold text-slate-900">{info.label}</h4>
              <span className="text-slate-500">{items.length}</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {items.map((alert, index) => (
                <li key={index} className="px-4 py-3 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="font-bold text-slate-900">{alert.franchiseName}{alert.storeName ? ` · ${alert.storeName}` : ''}</span>
                    <span className="block text-slate-700">{alert.title}</span>
                    {alert.detail && <span className="block text-slate-500">{alert.detail}</span>}
                  </div>
                  <button type="button" onClick={() => onOpenFranchise(alert.franchiseName)} className="inline-flex items-center gap-1 font-bold text-blue-700 hover:underline">
                    Ver franquia<ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {editing && settings && (
        <SettingsModal
          settings={settings}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function SettingsModal({ settings, onClose, onSaved }: { settings: NetworkAlertSettings; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ ...settings });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = 'mt-1 w-full border border-slate-200 rounded-lg p-2 bg-white';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await saveNetworkAlertSettings({
        noSaleDays: Math.min(60, Math.max(1, Math.round(form.noSaleDays))),
        cashDifference: Math.max(0, form.cashDifference),
        cashOpenHours: Math.min(240, Math.max(1, Math.round(form.cashOpenHours))),
        goalMinPercent: Math.min(100, Math.max(1, Math.round(form.goalMinPercent))),
      });
      await onSaved();
    } catch (saveError) {
      setError(errorText(saveError));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-white rounded-xl shadow-xl w-full max-w-md text-xs">
        <div className="p-4 border-b border-slate-100 flex justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Configurações dos alertas</h3>
            <p className="text-slate-500">Valem para todas as franquias da rede.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar"><X className="w-5 h-5 text-slate-400" /></button>
        </div>
        <div className="p-4 space-y-3">
          <label className="block font-bold text-slate-700">Loja sem vender há quantos dias
            <ValueInput decimals={0} value={form.noSaleDays} onValueChange={value => setForm({ ...form, noSaleDays: value ?? 1 })} className={input} />
          </label>
          <label className="block font-bold text-slate-700">Diferença de caixa acima de (R$)
            <ValueInput value={form.cashDifference} onValueChange={value => setForm({ ...form, cashDifference: value ?? 0 })} className={input} />
          </label>
          <label className="block font-bold text-slate-700">Caixa aberto há mais de (horas)
            <ValueInput decimals={0} value={form.cashOpenHours} onValueChange={value => setForm({ ...form, cashOpenHours: value ?? 1 })} className={input} />
          </label>
          <label className="block font-bold text-slate-700">Alertar quando a projeção ficar abaixo de (% da meta)
            <ValueInput decimals={0} value={form.goalMinPercent} onValueChange={value => setForm({ ...form, goalMinPercent: value ?? 70 })} className={input} />
          </label>
          {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</p>}
        </div>
        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 font-bold text-slate-600">Cancelar</button>
          <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">{busy ? 'Salvando...' : 'Salvar'}</button>
        </div>
      </form>
    </div>
  );
}
