import { useState } from 'react';
import { CheckCircle2, Megaphone, Paperclip } from 'lucide-react';
import { markAnnouncementRead, openAnnouncementAttachment, type AnnouncementAttachment, type MyAnnouncement } from '../db/insights';

// Comunicados da rede no ERP do franqueado (desenho aprovado em 2026-11-03).
// Importante = janela ao entrar com "Li e entendi"; Normal = lista com "não lido".

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'Não foi possível abrir.';

const formatDate = (value: string) => new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const formatSize = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function Attachments({ attachments }: { attachments: AnnouncementAttachment[] }) {
  const [error, setError] = useState('');
  if (!attachments.length) return null;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {attachments.map(attachment => (
          <button
            key={attachment.path}
            type="button"
            onClick={() => openAnnouncementAttachment(attachment).catch(openError => setError(errorText(openError)))}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold text-blue-700"
          >
            <Paperclip className="w-3.5 h-3.5" />{attachment.name}<span className="font-normal text-slate-400">{formatSize(attachment.size)}</span>
          </button>
        ))}
      </div>
      {error && <p className="text-rose-700">{error}</p>}
    </div>
  );
}

export default function AnnouncementsView({ announcements, onRead }: { announcements: MyAnnouncement[]; onRead: () => Promise<void> }) {
  const [openId, setOpenId] = useState<string | null>(null);

  const toggle = (announcement: MyAnnouncement) => {
    const opening = openId !== announcement.id;
    setOpenId(opening ? announcement.id : null);
    if (opening && !announcement.readAt) {
      void markAnnouncementRead(announcement.id).then(onRead).catch(() => undefined);
    }
  };

  return (
    <div className="space-y-4 text-xs">
      <div>
        <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2"><Megaphone className="w-5 h-5 text-blue-600" />Comunicados</h2>
        <p className="text-slate-500">Avisos enviados pela rede.</p>
      </div>
      {announcements.length === 0 && <p className="text-slate-400">Nenhum comunicado.</p>}
      {announcements.map(announcement => {
        const open = openId === announcement.id;
        return (
          <section key={announcement.id} className={`bg-white border rounded-xl shadow-xs overflow-hidden ${announcement.readAt ? 'border-slate-200' : 'border-blue-300'}`}>
            <button type="button" onClick={() => toggle(announcement)} className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-3 hover:bg-slate-50">
              {!announcement.readAt && <span className="h-2.5 w-2.5 rounded-full bg-blue-600 shrink-0" title="Não lido" />}
              <span className="min-w-0 flex-1">
                <strong className="text-sm text-slate-900">{announcement.title}</strong>
                <span className="block text-slate-500">{announcement.networkName} · {formatDate(announcement.createdAt)}{announcement.createdByName ? ` · ${announcement.createdByName}` : ''}{announcement.attachments.length ? ` · ${announcement.attachments.length} anexo(s)` : ''}</span>
              </span>
              {announcement.priority === 'IMPORTANTE' && <span className="px-2 py-0.5 rounded bg-rose-50 text-rose-700 font-bold">Importante</span>}
              {announcement.readAt && <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" />Lido</span>}
            </button>
            {open && (
              <div className="px-4 pb-4 space-y-3 border-t border-slate-100 pt-3">
                <p className="whitespace-pre-wrap text-slate-700 text-sm leading-relaxed">{announcement.body}</p>
                <Attachments attachments={announcement.attachments} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// Janela do comunicado IMPORTANTE ainda nao lido: so fecha com "Li e entendi".
export function ImportantAnnouncementModal({ announcement, onConfirmed }: { announcement: MyAnnouncement; onConfirmed: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await markAnnouncementRead(announcement.id);
      await onConfirmed();
      setBusy(false);
    } catch (confirmError) {
      setError(errorText(confirmError));
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[70] bg-slate-900/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-xl text-xs max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-slate-100">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-rose-50 text-rose-700 font-bold"><Megaphone className="w-3.5 h-3.5" />Comunicado importante · {announcement.networkName}</span>
          <h3 className="mt-2 text-base font-bold text-slate-900">{announcement.title}</h3>
          <p className="text-slate-500">{formatDate(announcement.createdAt)}{announcement.createdByName ? ` · ${announcement.createdByName}` : ''}</p>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <p className="whitespace-pre-wrap text-slate-700 text-sm leading-relaxed">{announcement.body}</p>
          <Attachments attachments={announcement.attachments} />
          {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</p>}
        </div>
        <div className="p-4 border-t border-slate-100 flex justify-end">
          <button type="button" onClick={() => void confirm()} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">
            <CheckCircle2 className="w-4 h-4" />{busy ? 'Registrando...' : 'Li e entendi'}
          </button>
        </div>
      </div>
    </div>
  );
}
