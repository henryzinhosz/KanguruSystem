import { useEffect, useState, useSyncExternalStore } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

// O App informa aqui se o aviso pode aparecer (nao pode no meio de uma venda).
let updateAllowed = true;
const gateListeners = new Set<() => void>();

export function setUpdateAllowed(value: boolean) {
  if (updateAllowed === value) return;
  updateAllowed = value;
  gateListeners.forEach((listener) => listener());
}

function useUpdateAllowed() {
  return useSyncExternalStore(
    (listener) => {
      gateListeners.add(listener);
      return () => gateListeners.delete(listener);
    },
    () => updateAllowed,
  );
}

export function UpdateGate() {
  return <UpdateNotice canShow={useUpdateAllowed()} />;
}

// Atualizacao automatica do PDV: procura versao nova ao abrir e a cada 4 horas. O aviso so
// aparece quando canShow = true (fora de uma venda em andamento). "Depois" mostra um alerta
// de que a versao antiga pode travar com funcionalidades novas.

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

type Stage = 'hidden' | 'offer' | 'warning' | 'installing' | 'error';

export function UpdateNotice({ canShow }: { canShow: boolean }) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [stage, setStage] = useState<Stage>('hidden');
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function lookForUpdate() {
      try {
        const found = await check();
        if (!cancelled && found) setUpdate(found);
      } catch {
        // Sem internet ou rodando fora do app instalado: tenta de novo no proximo ciclo.
      }
    }
    void lookForUpdate();
    const timer = window.setInterval(() => void lookForUpdate(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (update && canShow && stage === 'hidden' && dismissedVersion !== update.version) setStage('offer');
  }, [update, canShow, stage, dismissedVersion]);

  async function install() {
    if (!update) return;
    setStage('installing');
    setProgress(0);
    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        if (event.event === 'Progress') {
          received += event.data.chunkLength;
          if (total > 0) setProgress(Math.min(100, Math.round((received / total) * 100)));
        }
      });
      await relaunch();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
      setStage('error');
    }
  }

  if (!update || stage === 'hidden') return null;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="serial-unit-modal update-modal" role="dialog" aria-modal="true" aria-labelledby="update-title">
        {stage === 'offer' && (
          <>
            <p className="eyebrow">Atualização do PDV</p>
            <h2 id="update-title">Nova versão {update.version} disponível</h2>
            <p className="modal-copy">
              A atualização leva menos de um minuto. O PDV fecha, instala e abre de novo sozinho;
              a ativação do terminal e o caixa aberto continuam como estão.
            </p>
            {update.body && <p className="modal-copy update-notes">{update.body}</p>}
            <div className="modal-actions">
              <button className="text-action" type="button" onClick={() => { setDismissedVersion(update.version); setStage('warning'); }}>
                Depois
              </button>
              <button className="primary-action modal-confirm" type="button" onClick={() => void install()}>
                Atualizar agora
              </button>
            </div>
          </>
        )}
        {stage === 'warning' && (
          <>
            <p className="eyebrow">Atenção</p>
            <h2 id="update-title">PDV desatualizado</h2>
            <p className="modal-copy">
              A versão nova pode trazer funcionalidades que fazem o PDV desatualizado travar ou não
              funcionar corretamente. Atualize assim que possível: o aviso volta quando você abrir o PDV de novo.
            </p>
            <div className="modal-actions">
              <button className="primary-action modal-confirm" type="button" onClick={() => setStage('hidden')}>
                Fechar
              </button>
            </div>
          </>
        )}
        {stage === 'installing' && (
          <>
            <p className="eyebrow">Atualização do PDV</p>
            <h2 id="update-title">Instalando a versão {update.version}...</h2>
            <p className="modal-copy">
              {progress != null && progress < 100 ? `Baixando: ${progress}%` : 'Instalando. O PDV vai reabrir sozinho.'}
            </p>
          </>
        )}
        {stage === 'error' && (
          <>
            <p className="eyebrow">Atualização do PDV</p>
            <h2 id="update-title">Não foi possível atualizar</h2>
            <p className="modal-copy">Confira a internet e tente de novo. Detalhe: {errorText}</p>
            <div className="modal-actions">
              <button className="text-action" type="button" onClick={() => { setDismissedVersion(update.version); setStage('hidden'); }}>
                Fechar
              </button>
              <button className="primary-action modal-confirm" type="button" onClick={() => void install()}>
                Tentar de novo
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
