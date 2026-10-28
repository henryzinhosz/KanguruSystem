import { isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';
import { deviceSessionStorage } from '../device-session';
import { supabase } from './client';

// Falha de conexao (sem internet): o PDV entra no modo offline em vez de reativar o terminal.
export class OfflineError extends Error {
  constructor() {
    super('Sem conexão com a internet.');
    this.name = 'OfflineError';
  }
}

export const terminalAuth = {
  async restore(): Promise<Session | null> {
    const stored = await deviceSessionStorage.load();
    if (!stored) {
      return null;
    }

    const { data, error } = await supabase.auth.setSession({
      access_token: stored.accessToken,
      refresh_token: stored.refreshToken,
    });

    // Sem internet a renovacao falha por rede: NUNCA apagar a sessao guardada (ela e a
    // identidade do terminal ativado). So descarta quando o servidor recusou de verdade.
    if (error && isAuthRetryableFetchError(error)) {
      throw new OfflineError();
    }
    if (error || !data.session || !data.session.user.is_anonymous) {
      await deviceSessionStorage.clear();
      return null;
    }

    await deviceSessionStorage.save(data.session);
    return data.session;
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
      await deviceSessionStorage.clear();
      throw installError ?? new Error('A sessao anonima do dispositivo nao foi aplicada.');
    }

    await deviceSessionStorage.save(installed.session);
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
        void deviceSessionStorage.save(session).catch((error: unknown) => {
          console.error('[pdv-session] Credential Manager refresh write failed', error);
        });
      }
    });
  },
};