import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { DateRange, PeriodPreset } from '../db/finance';

// Filtros do Painel da Rede: menu de escolha (periodo, loja, franquia).

export const PERIOD_ORDER: PeriodPreset[] = ['hoje', '7dias', 'semana', 'mes', 'mes_passado'];

export function Dropdown({ label, value, placeholder, options, onChange }: {
  label: string;
  value: string;
  placeholder?: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const selected = options.find(option => option.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(previous => !previous)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`h-10 min-w-44 px-3 rounded-lg border font-bold inline-flex items-center justify-between gap-3 ${selected ? 'bg-white text-slate-800 border-blue-300 ring-1 ring-blue-100' : 'bg-white text-slate-500 border-slate-200'} hover:bg-slate-50`}
      >
        <span className="text-left leading-tight">
          <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
          <span className="block">{selected?.label ?? placeholder ?? 'Escolha'}</span>
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronUp className="w-4 h-4 text-slate-500" />}
      </button>
      {open && (
        <ul role="listbox" className="absolute left-0 top-full mt-1 z-30 min-w-full max-h-72 overflow-auto bg-white border border-slate-200 rounded-lg shadow-lg py-1">
          {options.map(option => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 font-semibold whitespace-nowrap ${option.value === value ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50'}`}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


// Periodo anterior para comparar: mes corrente -> mesmos dias do mes passado; demais -> mesmo tamanho logo antes.
export function previousRange(preset: PeriodPreset, range: DateRange): DateRange {
  if (preset === 'mes') {
    const start = new Date(range.start.getFullYear(), range.start.getMonth() - 1, 1);
    const days = Math.round((range.end.getTime() - range.start.getTime()) / 86400000);
    return { start, end: new Date(start.getFullYear(), start.getMonth(), 1 + days) };
  }
  if (preset === 'mes_passado') {
    return { start: new Date(range.start.getFullYear(), range.start.getMonth() - 1, 1), end: range.start };
  }
  const length = range.end.getTime() - range.start.getTime();
  return { start: new Date(range.start.getTime() - length), end: range.start };
}

