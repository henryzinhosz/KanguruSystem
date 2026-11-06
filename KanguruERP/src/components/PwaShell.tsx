import { useEffect, useState } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';

// ERP como aplicativo (PWA): aviso de versao nova e tela de "sem conexao".
// Os dados (vendas, clientes, estoque) nunca ficam guardados no aparelho: so a "casca" do app.

export default function PwaShell() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Procura versao nova a cada 30 minutos enquanto o ERP estiver aberto.
      if (registration) setInterval(() => { void registration.update(); }, 30 * 60 * 1000);
    },
  });

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return (
    <>
      {!online && (
        <div className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4" role="alert">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center mb-3">
              <WifiOff className="w-6 h-6" />
            </div>
            <h2 className="font-bold text-slate-900">Sem conexão</h2>
            <p className="text-sm text-slate-500 mt-1.5">O Kanguru ERP precisa de internet. Assim que a conexão voltar, esta tela some sozinha.</p>
            <p className="text-xs text-slate-400 mt-3">Para vender sem internet, use o PDV.</p>
          </div>
        </div>
      )}
      {needRefresh && (
        <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[90] bg-slate-900 text-white rounded-xl shadow-xl p-4 flex items-center gap-3 sm:max-w-sm" role="status">
          <RefreshCw className="w-5 h-5 text-blue-300 shrink-0" />
          <div className="flex-1 text-sm">
            <strong className="block">Nova versão disponível</strong>
            <span className="text-slate-300 text-xs">Atualize para usar as novidades.</span>
          </div>
          <button type="button" onClick={() => setNeedRefresh(false)} className="text-xs text-slate-300 hover:text-white px-2 py-1">Depois</button>
          <button type="button" onClick={() => void updateServiceWorker(true)} className="text-xs font-bold bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-2">Atualizar</button>
        </div>
      )}
    </>
  );
}
