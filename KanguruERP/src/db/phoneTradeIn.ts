import { supabase } from './supabaseClient';
import type { TradeInPhoneModel } from '../types';

// Tabela de avaliacao de iPhone da Troca Gamer (migration 20261129).
// Leitura pela RLS (empresa do usuario); escrita so pelas funcoes do banco (so o dono).

export async function listPhoneModels(): Promise<TradeInPhoneModel[]> {
  const { data, error } = await supabase
    .from('trade_in_phone_models')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('model_name', { ascending: true })
    .order('storage', { ascending: true });
  if (error) throw error;
  return (data || []).map(row => ({
    id: row.id,
    modelName: row.model_name,
    storage: row.storage,
    baseValue: Number(row.base_value),
    gradeAPercent: Number(row.grade_a_percent),
    gradeBPercent: Number(row.grade_b_percent),
    gradeCPercent: Number(row.grade_c_percent),
    batteryDeduction: Number(row.battery_deduction),
    isActive: row.is_active !== false,
    sortOrder: Number(row.sort_order ?? 0),
    updatedAt: row.updated_at || undefined,
    updatedByName: row.updated_by_name || undefined
  }));
}

export async function savePhoneModel(model: Omit<TradeInPhoneModel, 'id' | 'sortOrder' | 'updatedAt' | 'updatedByName'> & { id?: string }): Promise<string> {
  const { data, error } = await supabase.rpc('save_trade_in_phone_model', {
    p_id: model.id || null,
    p_model_name: model.modelName,
    p_storage: model.storage,
    p_base_value: model.baseValue,
    p_grade_a_percent: model.gradeAPercent,
    p_grade_b_percent: model.gradeBPercent,
    p_grade_c_percent: model.gradeCPercent,
    p_battery_deduction: model.batteryDeduction,
    p_is_active: model.isActive
  });
  if (error) throw error;
  return String(data);
}

export async function deletePhoneModel(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_trade_in_phone_model', { p_id: id });
  if (error) throw error;
}

export async function loadDefaultPhoneModels(): Promise<number> {
  const { data, error } = await supabase.rpc('load_default_trade_in_phone_models');
  if (error) throw error;
  return Number(data ?? 0);
}

// Mesma conta do PDV e do servidor: base - desconto do estado - bateria (84% ou menos).
export function phoneCashValue(model: Pick<TradeInPhoneModel, 'baseValue' | 'batteryDeduction'>, gradePercent: number, lowBattery: boolean): number {
  const value = model.baseValue * (1 - gradePercent / 100) - (lowBattery ? model.batteryDeduction : 0);
  return Math.max(0, Math.round(value * 100) / 100);
}
