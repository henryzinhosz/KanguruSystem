import { useEffect, useState } from 'react';
import { CalendarDays, Plus, X } from 'lucide-react';
import type { SettlementRule, SettlementRules, StoreConfig } from '../types';
import { DEFAULT_SETTLEMENT_RULES, rulesOf } from '../db/receivables';
import ValueInput from './ValueInput';

// Quando o dinheiro de cada forma de pagamento cai na conta, por loja (previsao de recebimentos).
// Cada maquininha/plano e diferente: a loja escolhe e pode incluir feriados locais.

interface SettlementRulesEditorProps {
  stores: StoreConfig[];
  selectedUnit: string;
  onSelectUnit: (unitId: string) => void;
  updateStoreConfig: (unitId: string, updated: Partial<StoreConfig>) => unknown;
}

const inputClass = 'w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-xs outline-none focus:ring-1 focus:ring-blue-500';

function RuleRow({ label, rule, allowInstallments, onChange }: {
  label: string;
  rule: SettlementRule;
  allowInstallments?: boolean;
  onChange: (rule: SettlementRule) => void;
}) {
  return (
    <div className="grid grid-cols-[90px_1fr_110px] items-end gap-3">
      <span className="pb-2 font-bold text-slate-700">{label}</span>
      <label className="block space-y-1">
        <span className="block text-[11px] text-slate-500">Quando cai</span>
        <select
          value={rule.mode}
          onChange={event => {
            const mode = event.target.value as SettlementRule['mode'];
            onChange({ mode, days: mode === 'BUSINESS_DAYS' ? Math.max(1, rule.days || 1) : 0 });
          }}
          className={inputClass}
        >
          <option value="IMMEDIATE">Na hora (no dia da venda)</option>
          <option value="BUSINESS_DAYS">Depois de alguns dias úteis</option>
          {allowInstallments && <option value="INSTALLMENTS">Parcela por parcela (30, 60, 90 dias...)</option>}
        </select>
      </label>
      {rule.mode === 'BUSINESS_DAYS' ? (
        <label className="block space-y-1">
          <span className="block text-[11px] text-slate-500">Dias úteis</span>
          <ValueInput decimals={0} value={rule.days} onValueChange={value => onChange({ ...rule, days: Math.max(1, Math.min(60, value ?? 1)) })} className={inputClass} />
        </label>
      ) : <span />}
    </div>
  );
}

export default function SettlementRulesEditor({ stores, selectedUnit, onSelectUnit, updateStoreConfig }: SettlementRulesEditorProps) {
  const store = stores.find(item => item.unitId === selectedUnit);
  const [rules, setRules] = useState<SettlementRules>(rulesOf(store));
  const [newHoliday, setNewHoliday] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    setRules(rulesOf(store));
    setError('');
    setMessage('');
  }, [selectedUnit, store?.settlementRules]);

  const columnMissing = store !== undefined && store.settlementRules === undefined;

  const addHoliday = () => {
    const match = newHoliday.trim().match(/^(\d{1,2})\/(\d{1,2})$/);
    if (!match) return setError('Digite o feriado como dia/mês, por exemplo 20/01.');
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return setError('Data inválida.');
    const key = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!rules.extraHolidays.includes(key)) setRules({ ...rules, extraHolidays: [...rules.extraHolidays, key].sort() });
    setNewHoliday('');
    setError('');
  };

  const save = async () => {
    if (!store) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await updateStoreConfig(store.unitId, { settlementRules: rules });
      setMessage('Regras de recebimento salvas.');
    } catch (saveError) {
      setError(`Não foi possível salvar: ${saveError instanceof Error ? saveError.message : (saveError as { message?: string })?.message || 'erro no banco'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto bg-white p-6 rounded-xl border border-slate-200 shadow-sm font-sans space-y-4 text-xs">
      <div>
        <h3 className="text-base font-bold text-slate-950 uppercase tracking-tight flex items-center gap-2">
          <CalendarDays className="w-5 h-5 text-blue-600" />Quando o dinheiro cai na conta
        </h3>
        <p className="text-xs text-slate-400">Usado na aba Recebimentos. Cada maquininha e plano é diferente: ajuste para esta loja.</p>
      </div>

      <label className="block space-y-1">
        <span className="font-bold text-slate-700">Loja</span>
        <select value={selectedUnit} onChange={event => onSelectUnit(event.target.value)} className={inputClass}>
          {stores.map(item => <option key={item.unitId} value={item.unitId}>{item.tradeName || item.unitId}</option>)}
        </select>
      </label>

      {columnMissing && (
        <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg">Aplique a migration 20261202 para salvar estas regras.</div>
      )}

      <div className="space-y-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
        <RuleRow label="Pix" rule={rules.pix} onChange={pix => setRules({ ...rules, pix })} />
        <RuleRow label="Débito" rule={rules.debito} onChange={debito => setRules({ ...rules, debito })} />
        <RuleRow label="Crédito" rule={rules.credito} allowInstallments onChange={credito => setRules({ ...rules, credito })} />
      </div>

      <label className="block space-y-1">
        <span className="font-bold text-slate-700">Dias em que a loja recebe</span>
        <select value={rules.businessDays} onChange={event => setRules({ ...rules, businessDays: event.target.value as SettlementRules['businessDays'] })} className={inputClass}>
          <option value="MON_SAT">Segunda a sábado</option>
          <option value="MON_FRI">Segunda a sexta</option>
        </select>
        <span className="block text-[11px] text-slate-500">Domingos e feriados nacionais/bancários (inclusive Carnaval, Sexta-feira Santa e Corpus Christi) nunca contam.</span>
      </label>

      <div className="space-y-2">
        <span className="block font-bold text-slate-700">Feriados extras (estaduais ou municipais)</span>
        <div className="flex flex-wrap gap-1.5">
          {rules.extraHolidays.length === 0 && <span className="text-slate-400">Nenhum. Inclua se o repasse atrasar em algum feriado local.</span>}
          {rules.extraHolidays.map(key => (
            <span key={key} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-100 text-slate-700 font-mono">
              {key.slice(3)}/{key.slice(0, 2)}
              <button type="button" aria-label="Remover feriado" onClick={() => setRules({ ...rules, extraHolidays: rules.extraHolidays.filter(item => item !== key) })} className="text-slate-400 hover:text-rose-600">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={newHoliday}
            onChange={event => setNewHoliday(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addHoliday(); } }}
            placeholder="dia/mês, ex.: 20/01"
            className={`${inputClass} max-w-[160px] font-mono`}
          />
          <button type="button" onClick={addHoliday} className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold text-slate-700">
            <Plus className="w-3.5 h-3.5" />Incluir
          </button>
        </div>
        <span className="block text-[11px] text-slate-500">Vale para todos os anos.</span>
      </div>

      {error && <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg font-medium">{error}</div>}
      {message && <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg font-medium">{message}</div>}

      <div className="flex justify-between gap-2">
        <button type="button" onClick={() => setRules(DEFAULT_SETTLEMENT_RULES)} className="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold text-slate-700">
          Voltar ao padrão
        </button>
        <button type="button" disabled={saving || !store || columnMissing} onClick={() => void save()} className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold disabled:opacity-50">
          {saving ? 'Salvando...' : 'Salvar regras de recebimento'}
        </button>
      </div>
    </div>
  );
}
