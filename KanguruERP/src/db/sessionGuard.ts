import { supabase } from './supabaseClient';

// Sai sozinho depois de 60 minutos sem uso (mouse, teclado/leitor, toque ou rolagem).
const IDLE_LIMIT_MS = 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 1000;

export function startSessionGuard() {
  let lastActivity = Date.now();
  const touch = () => { lastActivity = Date.now(); };
  (['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const)
    .forEach(event => window.addEventListener(event, touch, { passive: true, capture: true }));

  window.setInterval(() => {
    if (Date.now() - lastActivity < IDLE_LIMIT_MS) return;
    touch();
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) void supabase.auth.signOut();
    });
  }, CHECK_EVERY_MS);
}
