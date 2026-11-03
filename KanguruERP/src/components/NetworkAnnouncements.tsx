import { ChangeEvent, FormEvent, useEffect, useState } from 'react';
import { Archive, ArchiveRestore, CheckCircle2, ChevronDown, ChevronUp, Megaphone, Paperclip, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  listNetworkAnnouncements,
  listNetworkFranchises,
  removeAnnouncementAttachment,
  saveNetworkAnnouncement,
  setNetworkAnnouncementArchived,
  uploadAnnouncementAttachment,
  type NetworkAnnouncement,
  type NetworkFranchise,
} from '../db/network';
import { openAnnouncementAttachment, type AnnouncementAttachment } from '../db/insights';

// Painel da Rede › Comunicados (desenho aprovado em 2026-11-03): aviso para o ERP dos franqueados.
// Publico escolhido em cada comunicado (so donos ou donos + gerentes); anexos PDF/imagem ate 10 MB.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : (error as { message?: string })?.message || 'Erro ao salvar.';
const formatDate = (value: string) => new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString('pt-BR');
const formatDateTime = (value: string) => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

interface Draft {
  id: string;
  isNew: boolean;
  title: string;
  body: string;
  priority: 'NORMAL' | 'IMPORTANTE';
  audience: 'OWNERS' | 'ALL';
  allFranchises: boolean;
  targetTenantIds: string[];
  expiresOn: string;
  attachments: AnnouncementAttachment[];
}

export default function NetworkAnnouncements({ networkId }: { networkId: string }) {
  const [announcements, setAnnouncements] = useState<NetworkAnnouncement[]>([]);
  const [franchises, setFranchises] = useState<NetworkFranchise[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [rows, franchiseRows] = await Promise.all([listNetworkAnnouncements(), listNetworkFranchises()]);
      setAnnouncements(rows);
      setFranchises(franchiseRows);
    } catch (loadError) {
      setError(`Não foi possível carregar os comunicados: ${errorText(loadError)}. Confira se a migration 20261119 foi aplicada.`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openNew = () => {
    setMessage('');
    setDraft({
      id: crypto.randomUUID(), isNew: true, title: '', body: '', priority: 'NORMAL', audience: 'OWNERS',
      allFranchises: true, targetTenantIds: [], expiresOn: '', attachments: [],
    });
  };

  const openEdit = (announcement: NetworkAnnouncement) => {
    setMessage('');
    setDraft({
      id: announcement.id, isNew: false, title: announcement.title, body: announcement.body,
      priority: announcement.priority, audience: announcement.audience,
      allFranchises: !announcement.targetTenantIds, targetTenantIds: announcement.targetTenantIds ?? [],
      expiresOn: announcement.expiresOn ?? '', attachments: announcement.attachments,
    });
  };

  const archive = async (announcement: NetworkAnnouncement) => {
    try {
      await setNetworkAnnouncementArchived(announcement.id, !announcement.archived);
      setMessage(announcement.archived ? 'Comunicado reativado.' : 'Comunicado arquivado: não aparece mais para os franqueados.');
      await load();
    } catch (archiveError) {
      setError(errorText(archiveError));
    }
  };

  const visible = announcements.filter(item => showArchived || !item.archived);
  const archivedCount = announcements.filter(item => item.archived).length;

  return (
    <div className="space-y-4 text-xs">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs p-3 flex flex-wrap items-center gap-2">
        <span className="text-slate-500">Importante: abre uma janela no ERP do franqueado com "Li e entendi". Normal: aparece em Comunicados.</span>
        <div className="ml-auto flex gap-2">
          {archivedCount > 0 && (
            <button type="button" onClick={() => setShowArchived(current => !current)} className="h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-bold">
              {showArchived ? 'Esconder arquivados' : `Ver arquivados (${archivedCount})`}
            </button>
          )}
          <button type="button" onClick={openNew} className="h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold inline-flex items-center gap-1.5"><Plus className="w-4 h-4" />Novo comunicado</button>
        </div>
      </div>

      {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</p>}
      {message && <p className="text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">{message}</p>}
      {!loading && visible.length === 0 && <p className="text-slate-400">Nenhum comunicado enviado.</p>}

      {visible.map(announcement => {
        const recipients = announcement.franchises.reduce((sum, item) => sum + item.recipients, 0);
        const reads = announcement.franchises.reduce((sum, item) => sum + item.reads.length, 0);
        const franchisesRead = announcement.franchises.filter(item => item.reads.length > 0).length;
        const open = expanded === announcement.id;
        return (
          <section key={announcement.id} className={`bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden ${announcement.archived ? 'opacity-60' : ''}`}>
            <div className="px-4 py-3 flex flex-wrap items-center gap-3">
              <span className="p-2 rounded-lg border bg-blue-50 text-blue-600 border-blue-100"><Megaphone className="w-4 h-4" /></span>
              <div className="min-w-0 flex-1">
                <strong className="text-sm text-slate-900">{announcement.title}</strong>
                <span className="block text-slate-500">
                  {formatDateTime(announcement.createdAt)}{announcement.createdByName ? ` · ${announcement.createdByName}` : ''}
                  {' · '}{announcement.audience === 'ALL' ? 'donos e gerentes' : 'só donos'}
                  {' · '}{announcement.targetTenantIds ? `${announcement.targetTenantIds.length} franquia(s)` : 'todas as franquias'}
                  {announcement.expiresOn ? ` · até ${formatDate(announcement.expiresOn)}` : ''}
                  {announcement.attachments.length ? ` · ${announcement.attachments.length} anexo(s)` : ''}
                  {announcement.archived ? ' · arquivado' : ''}
                </span>
              </div>
              {announcement.priority === 'IMPORTANTE' && <span className="px-2 py-0.5 rounded bg-rose-50 text-rose-700 font-bold">Importante</span>}
              <button type="button" onClick={() => setExpanded(open ? null : announcement.id)} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-100 font-bold text-slate-700">
                Lido por {franchisesRead} de {announcement.franchises.length} franquia(s) · {reads}/{recipients} pessoa(s)
                {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
              <button type="button" onClick={() => openEdit(announcement)} className="p-2 text-blue-700 rounded-lg hover:bg-blue-50" title="Editar"><Pencil className="w-4 h-4" /></button>
              <button type="button" onClick={() => void archive(announcement)} className="p-2 text-slate-600 rounded-lg hover:bg-slate-100" title={announcement.archived ? 'Reativar' : 'Arquivar'}>
                {announcement.archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
              </button>
            </div>
            {open && (
              <div className="border-t border-slate-100 px-4 py-3 space-y-3">
                <p className="whitespace-pre-wrap text-slate-700">{announcement.body}</p>
                {announcement.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {announcement.attachments.map(attachment => (
                      <button key={attachment.path} type="button" onClick={() => openAnnouncementAttachment(attachment).catch(openError => setError(errorText(openError)))} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 font-bold text-blue-700 hover:bg-slate-50">
                        <Paperclip className="w-3.5 h-3.5" />{attachment.name}
                      </button>
                    ))}
                  </div>
                )}
                <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                  {announcement.franchises.map(franchise => (
                    <li key={franchise.tenantId} className="px-3 py-2 flex flex-wrap items-start gap-3">
                      <span className="font-bold text-slate-800 min-w-[180px]">{franchise.name}</span>
                      <span className="flex-1 text-slate-600">
                        {franchise.reads.length === 0
                          ? <span className="text-amber-700 font-semibold">Ninguém leu ainda ({franchise.recipients} pessoa(s) devem ler)</span>
                          : franchise.reads.map(reading => `${reading.displayName || reading.email || 'Usuário'} em ${formatDateTime(reading.readAt)}`).join(' · ')}
                      </span>
                      {franchise.reads.length > 0 && <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}

      {draft && (
        <AnnouncementModal
          draft={draft}
          networkId={networkId}
          franchises={franchises}
          onClose={() => setDraft(null)}
          onSaved={async text => {
            setDraft(null);
            setMessage(text);
            await load();
          }}
        />
      )}
    </div>
  );
}

function AnnouncementModal({ draft: initial, networkId, franchises, onClose, onSaved }: {
  draft: Draft;
  networkId: string;
  franchises: NetworkFranchise[];
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [uploaded, setUploaded] = useState<string[]>([]); // enviados nesta janela (apagados se cancelar)
  const [removed, setRemoved] = useState<string[]>([]); // ja salvos e retirados (apagados depois de salvar)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = 'mt-1 w-full border border-slate-200 rounded-lg p-2 bg-white';

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files: File[] = Array.from(event.target.files ?? []);
    event.target.value = '';
    setError('');
    for (const file of files) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setError(`"${file.name}": só PDF ou imagem (PNG, JPG, WEBP).`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`"${file.name}" passa de 10 MB.`);
        continue;
      }
      setBusy(true);
      try {
        const attachment = await uploadAnnouncementAttachment(networkId, draft.id, file);
        setUploaded(current => [...current, attachment.path]);
        setDraft(current => ({ ...current, attachments: [...current.attachments, attachment] }));
      } catch (uploadError) {
        setError(`Não foi possível enviar "${file.name}": ${errorText(uploadError)}`);
      } finally {
        setBusy(false);
      }
    }
  };

  const removeAttachment = (attachment: AnnouncementAttachment) => {
    setDraft(current => ({ ...current, attachments: current.attachments.filter(item => item.path !== attachment.path) }));
    if (uploaded.includes(attachment.path)) {
      setUploaded(current => current.filter(path => path !== attachment.path));
      void removeAnnouncementAttachment(attachment.path).catch(() => undefined);
    } else {
      setRemoved(current => [...current, attachment.path]);
    }
  };

  const cancel = () => {
    uploaded.forEach(path => void removeAnnouncementAttachment(path).catch(() => undefined));
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.allFranchises && draft.targetTenantIds.length === 0) {
      setError('Escolha ao menos uma franquia.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveNetworkAnnouncement({
        id: draft.id, title: draft.title.trim(), body: draft.body, priority: draft.priority, audience: draft.audience,
        targetTenantIds: draft.allFranchises ? null : draft.targetTenantIds, expiresOn: draft.expiresOn || null,
        attachments: draft.attachments,
      });
      removed.forEach(path => void removeAnnouncementAttachment(path).catch(() => undefined));
      await onSaved(draft.isNew ? 'Comunicado enviado.' : 'Comunicado atualizado.');
    } catch (saveError) {
      setError(errorText(saveError));
      setBusy(false);
    }
  };

  const toggleTenant = (tenantId: string) => setDraft(current => ({
    ...current,
    targetTenantIds: current.targetTenantIds.includes(tenantId)
      ? current.targetTenantIds.filter(id => id !== tenantId)
      : [...current.targetTenantIds, tenantId],
  }));

  const choice = (active: boolean) => `p-3 rounded-lg border text-left ${active ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-200' : 'border-slate-200 hover:bg-slate-50'}`;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-white rounded-xl shadow-xl w-full max-w-2xl text-xs max-h-[92vh] flex flex-col">
        <div className="p-4 border-b border-slate-100 flex justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">{draft.isNew ? 'Novo comunicado' : 'Editar comunicado'}</h3>
          <button type="button" onClick={cancel} aria-label="Fechar"><X className="w-5 h-5 text-slate-400" /></button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <label className="block font-bold text-slate-700">Título
            <input required maxLength={160} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} className={input} />
          </label>
          <label className="block font-bold text-slate-700">Mensagem
            <textarea rows={7} value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} className={input} />
          </label>

          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setDraft({ ...draft, priority: 'NORMAL' })} className={choice(draft.priority === 'NORMAL')}>
              <span className="block font-bold text-slate-900">Normal</span><span className="text-slate-500">Aparece em Comunicados, marcado como não lido</span>
            </button>
            <button type="button" onClick={() => setDraft({ ...draft, priority: 'IMPORTANTE' })} className={choice(draft.priority === 'IMPORTANTE')}>
              <span className="block font-bold text-slate-900">Importante</span><span className="text-slate-500">Abre uma janela ao entrar no ERP, com "Li e entendi"</span>
            </button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setDraft({ ...draft, audience: 'OWNERS' })} className={choice(draft.audience === 'OWNERS')}>
              <span className="block font-bold text-slate-900">Só o dono da franquia</span><span className="text-slate-500">Usuários administradores do ERP</span>
            </button>
            <button type="button" onClick={() => setDraft({ ...draft, audience: 'ALL' })} className={choice(draft.audience === 'ALL')}>
              <span className="block font-bold text-slate-900">Dono e gerentes de loja</span><span className="text-slate-500">Todos os usuários do ERP da franquia</span>
            </button>
          </div>

          <fieldset className="space-y-2">
            <legend className="font-bold text-slate-700">Franquias</legend>
            <label className="flex items-center gap-2"><input type="radio" checked={draft.allFranchises} onChange={() => setDraft({ ...draft, allFranchises: true })} />Todas as franquias da rede</label>
            <label className="flex items-center gap-2"><input type="radio" checked={!draft.allFranchises} onChange={() => setDraft({ ...draft, allFranchises: false })} />Escolher franquias</label>
            {!draft.allFranchises && (
              <div className="grid gap-1 sm:grid-cols-2 border border-slate-200 rounded-lg p-2 max-h-40 overflow-y-auto">
                {franchises.map(franchise => (
                  <label key={franchise.tenantId} className="flex items-center gap-2">
                    <input type="checkbox" checked={draft.targetTenantIds.includes(franchise.tenantId)} onChange={() => toggleTenant(franchise.tenantId)} />
                    {franchise.tradeName || franchise.legalName}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <label className="block font-bold text-slate-700">Válido até (opcional)
            <input type="date" value={draft.expiresOn} onChange={event => setDraft({ ...draft, expiresOn: event.target.value })} className={`${input} sm:w-56`} />
          </label>

          <div className="space-y-2">
            <span className="block font-bold text-slate-700">Anexos (PDF ou imagem, até 10 MB cada)</span>
            {draft.attachments.map(attachment => (
              <div key={attachment.path} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
                <Paperclip className="w-3.5 h-3.5 text-slate-400" />
                <span className="flex-1 truncate">{attachment.name}</span>
                <button type="button" onClick={() => removeAttachment(attachment)} className="p-1 text-rose-600" title="Remover anexo"><Trash2 className="w-4 h-4" /></button>
              </div>
            ))}
            <label className={`inline-flex items-center gap-1.5 font-bold text-blue-700 cursor-pointer hover:underline ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
              <Plus className="w-3.5 h-3.5" />Adicionar anexo
              <input type="file" multiple accept=".pdf,image/png,image/jpeg,image/webp" onChange={event => void addFiles(event)} className="hidden" />
            </label>
          </div>
          {error && <p className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</p>}
        </div>
        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
          <button type="button" onClick={cancel} className="px-4 py-2 rounded-lg border border-slate-200 font-bold text-slate-600">Cancelar</button>
          <button type="submit" disabled={busy} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">{busy ? 'Aguarde...' : draft.isNew ? 'Enviar comunicado' : 'Salvar'}</button>
        </div>
      </form>
    </div>
  );
}
