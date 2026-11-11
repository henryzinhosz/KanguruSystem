import { isAuthRetryableFetchError, type AuthError, type Session } from '@supabase/supabase-js';
import { deviceSessionStorage } from '../device-session';
import { supabase } from './client';

// Falha de conexao (sem internet): o PDV entra no modo offline em vez de reativar o terminal.
export class OfflineError extends Error {
  constructor() {
    super('Sem conexão com a internet.');
    this.name = 'OfflineError';
  }
}

// Queda do servidor ou excesso de acessos nao dizem nada sobre a chave: ela continua valida.
function isTemporaryFailure(error: AuthError): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  const status = error.status ?? 0;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

const REFUSAL_KEY = 'kanguru.terminal.refusal';

// Guarda so o motivo (nunca a chave) para aparecer na tela de ativacao.
function rememberRefusal(error: AuthError | null) {
  try {
    const reason = error?.code || (error?.status ? `HTTP ${error.status}` : 'sessão inválida');
    localStorage.setItem(REFUSAL_KEY, `${reason} (${new Date().toLocaleString('pt-BR')})`);
  } catch {
    // so diagnostico
  }
}

// Gravacoes em fila: na ordem em que a chave mudou, repetindo se o Windows falhar.
let saveQueue: Promise<void> = Promise.resolve();

function queueSave(session: Session): Promise<void> {
  const write = async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await deviceSessionStorage.save(session);
        return;
      } catch (error) {
        if (attempt >= 3) {
          console.error('[pdv-session] Credential Manager write failed', error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
  };
  saveQueue = saveQueue.then(write);
  return saveQueue;
}

async function restoreSession(): Promise<Session | null> {
  // A sessao em memoria e sempre a mais nova; o cofre pode estar um passo atras.
  const { data: current } = await supabase.auth.getSession();
  if (current.session?.user.is_anonymous) {
    await queueSave(current.session);
    return current.session;
  }

  const stored = await deviceSessionStorage.load();
  if (!stored) {
    return null;
  }

  const { data, error } = await supabase.auth.setSession({
    access_token: stored.accessToken,
    refresh_token: stored.refreshToken,
  });

  // A chave e a identidade do terminal ativado: falha temporaria nunca a descarta.
  if (error && isTemporaryFailure(error)) {
    throw new OfflineError();
  }
  if (error || !data.session || !data.session.user.is_anonymous) {
    rememberRefusal(error);
    return null;
  }

  await queueSave(data.session);
  return data.session;
}

// Uma restauracao por vez: duas renovacoes com a mesma chave podem invalida-la.
let restoring: Promise<Session | null> | null = null;

export const terminalAuth = {
  restore(): Promise<Session | null> {
    if (!restoring) {
      restoring = restoreSession().finally(() => {
        restoring = null;
      });
    }
    return restoring;
  },
  async ensureAnonymousSession(): Promise<Session> {
    const restored = await this.restore();
    if (restored) {
      return restored;
    }

    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.session) {
      throw error ?? new Error('Nao foi possivel iniciar a sessao segura do dispositivo.');
    }

    // PersistSession is disabled, so explicitly install the fresh token in this client.
    const { data: installed, error: installError } = await supabase.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    if (installError || !installed.session || !installed.session.user.is_anonymous) {
      throw installError ?? new Error('A sessao anonima do dispositivo nao foi aplicada.');
    }

    await queueSave(installed.session);
    return installed.session;
  },
  async requireAnonymousSession(): Promise<Session> {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user.is_anonymous) {
      return data.session;
    }

    return this.ensureAnonymousSession();
  },
  watchSession() {
    return supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        void queueSave(session);
      }
    });
  },
  // Antes de instalar uma atualizacao: para a renovacao e garante a chave mais nova no cofre.
  async prepareForRestart(): Promise<void> {
    try {
      await supabase.auth.stopAutoRefresh();
      const { data } = await supabase.auth.getSession();
      if (data.session) await queueSave(data.session);
      await saveQueue;
    } catch (error) {
      console.error('[pdv-session] prepare for restart failed', error);
    }
  },
  resumeAfterFailedRestart() {
    void supabase.auth.startAutoRefresh();
  },
  lastRefusal(): string | null {
    try {
      return localStorage.getItem(REFUSAL_KEY);
    } catch {
      return null;
    }
  },
  clearRefusal() {
    try {
      localStorage.removeItem(REFUSAL_KEY);
    } catch {
      // so diagnostico
    }
  },
};
