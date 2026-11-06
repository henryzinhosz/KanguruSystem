// Impressao de um PDF (DANFSe da NFS-e) pela janela de impressao do Windows: o PDF vira um
// endereco local (blob) num quadro invisivel e o leitor de PDF do proprio WebView imprime.

export function printPdfBase64(base64: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let url = '';
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    } catch (error) {
      reject(error);
      return;
    }
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', right: '0', bottom: '0' });
    const cleanup = () => {
      frame.remove();
      URL.revokeObjectURL(url);
    };
    frame.onload = () => {
      // O leitor de PDF precisa de um instante para carregar antes de imprimir.
      setTimeout(() => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
          resolve();
        } catch (error) {
          reject(error);
        }
        setTimeout(cleanup, 60000);
      }, 800);
    };
    frame.src = url;
    document.body.appendChild(frame);
  });
}
