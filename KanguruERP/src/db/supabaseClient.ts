import { createClient } from '@supabase/supabase-js';

const DEFAULT_SUPABASE_URL = 'https://qnxmboxwluuyjvgiqlbm.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFueG1ib3h3bHV1eWp2Z2lxbGJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMjk3NjMsImV4cCI6MjA5OTkwNTc2M30.HxfLzGhHXGUHpmS_vtA4eb1WXGK9fK8Q0APhLI72D74';

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const hasConfiguredEnv = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY);
const useDevFallback = !hasConfiguredEnv && import.meta.env.DEV;

const supabaseUrl = env.VITE_SUPABASE_URL || (useDevFallback ? DEFAULT_SUPABASE_URL : '');
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || (useDevFallback ? DEFAULT_SUPABASE_ANON_KEY : '');

if (!hasConfiguredEnv) {
  if (import.meta.env.PROD) {
    throw new Error('[SECURITY] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be defined in production.');
  }

  console.warn('[SECURITY] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is missing. Using a hardcoded fallback anon key is insecure and should only be used for local development.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export function getSupabaseConfig() {
  return {
    url: supabaseUrl,
    isFallback: !hasConfiguredEnv && import.meta.env.DEV
  };
}
