import { isTauri } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';

// Banco local do modo offline (SQLite no computador da loja; no navegador de desenvolvimento,
// localStorage). Guarda a copia de dados para vender sem internet (kv) e a fila de vendas e
// movimentos de caixa feitos sem internet (outbox), enviados quando a conexao volta.

export type OutboxKind = 'SALE' | 'MOVEMENT';
export type OutboxStatus = 'PENDENTE' | 'ERRO' | 'ENVIADO';

export interface OutboxEntry {
  id: string;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  createdAt: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
}

interface Store {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  enqueue(entry: OutboxEntry): Promise<void>;
  list(status?: OutboxStatus[]): Promise<OutboxEntry[]>;
  update(id: string, patch: Partial<Pick<OutboxEntry, 'status' | 'attempts' | 'lastError'>>): Promise<void>;
}

class SqliteStore implements Store {
  private constructor(private db: Database) {}

  static async open(): Promise<SqliteStore> {
    const db = await Database.load('sqlite:kanguru-offline.db');
    await db.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    await db.execute(`CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
    return new SqliteStore(db);
  }

  async get(key: string) {
    const rows = await this.db.select<{ value: string }[]>('SELECT value FROM kv WHERE key = $1', [key]);
    return rows[0] ? JSON.parse(rows[0].value) : null;
  }

  async set(key: string, value: unknown) {
    await this.db.execute(
      'INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, JSON.stringify(value), new Date().toISOString()],
    );
  }

  async enqueue(entry: OutboxEntry) {
    await this.db.execute(
      'INSERT OR IGNORE INTO outbox (id, kind, payload, created_at, status, attempts, last_error) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [entry.id, entry.kind, JSON.stringify(entry.payload), entry.createdAt, entry.status, entry.attempts, entry.lastError],
    );
  }

  async list(status?: OutboxStatus[]) {
    const rows = await this.db.select<Array<Record<string, unknown>>>('SELECT * FROM outbox ORDER BY created_at');
    return rows
      .map((row) => ({
        id: String(row.id),
        kind: row.kind as OutboxKind,
        payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
        createdAt: String(row.created_at),
        status: row.status as OutboxStatus,
        attempts: Number(row.attempts ?? 0),
        lastError: (row.last_error as string | null) ?? null,
      }))
      .filter((entry) => !status || status.includes(entry.status));
  }

  async update(id: string, patch: Partial<Pick<OutboxEntry, 'status' | 'attempts' | 'lastError'>>) {
    const current = (await this.list()).find((entry) => entry.id === id);
    if (!current) return;
    const next = { ...current, ...patch };
    await this.db.execute('UPDATE outbox SET status = $1, attempts = $2, last_error = $3 WHERE id = $4', [
      next.status, next.attempts, next.lastError, id,
    ]);
  }
}

// Desenvolvimento no navegador (npm run dev sem Tauri).
class BrowserStore implements Store {
  private read<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`kanguru-offline:${key}`);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private write(key: string, value: unknown) {
    try {
      localStorage.setItem(`kanguru-offline:${key}`, JSON.stringify(value));
    } catch {
      // armazenamento cheio ou bloqueado: so no desenvolvimento
    }
  }

  async get(key: string) {
    return this.read<unknown | null>(`kv:${key}`, null);
  }

  async set(key: string, value: unknown) {
    this.write(`kv:${key}`, value);
  }

  async enqueue(entry: OutboxEntry) {
    const list = this.read<OutboxEntry[]>('outbox', []);
    if (!list.some((item) => item.id === entry.id)) this.write('outbox', [...list, entry]);
  }

  async list(status?: OutboxStatus[]) {
    return this.read<OutboxEntry[]>('outbox', []).filter((entry) => !status || status.includes(entry.status));
  }

  async update(id: string, patch: Partial<Pick<OutboxEntry, 'status' | 'attempts' | 'lastError'>>) {
    this.write('outbox', this.read<OutboxEntry[]>('outbox', []).map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }
}

let storePromise: Promise<Store> | null = null;

export function offlineStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = (isTauri() ? SqliteStore.open() : Promise.resolve(new BrowserStore())).catch(() => new BrowserStore());
  }
  return storePromise;
}
