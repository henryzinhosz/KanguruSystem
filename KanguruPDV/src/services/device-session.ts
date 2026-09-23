import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Session } from '@supabase/supabase-js';

interface StoredDeviceSession {
  accessToken: string;
  refreshToken: string;
}

let browserSession: StoredDeviceSession | null = null;

function serialize(session: Session): string {
  return JSON.stringify({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  } satisfies StoredDeviceSession);
}

function parse(value: string): StoredDeviceSession | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredDeviceSession>;
    if (typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string') {
      return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
    }
  } catch {
    return null;
  }

  return null;
}

export const deviceSessionStorage = {
  async load(): Promise<StoredDeviceSession | null> {
    if (!isTauri()) {
      return browserSession;
    }

    const stored = await invoke<string | null>('load_device_session');
    return stored ? parse(stored) : null;
  },
  async save(session: Session): Promise<void> {
    const serialized = serialize(session);
    if (!isTauri()) {
      browserSession = parse(serialized);
      return;
    }

    await invoke('save_device_session', { session: serialized });
  },
  async clear(): Promise<void> {
    browserSession = null;
    if (isTauri()) {
      await invoke('clear_device_session');
    }
  },
};