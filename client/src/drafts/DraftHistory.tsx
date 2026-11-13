import { useEffect, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import { FilePenLine, Trash2 } from 'lucide-react';
import { useAuthContext, useNewConvo } from '~/hooks';
import { encodeBase64 } from '~/utils/drafts';
import { requestChatFocus } from '~/utils/focus';
import store from '~/store';
import {
  ChatDraft,
  DRAFT_ERROR,
  DRAFTS_CHANGED,
  listChatDrafts,
  readChatDraft,
  removeChatDraft,
  requestDraftArchive,
  reportDraftError,
  activeDraftId,
  selectChatDraft,
} from './history';

export default function DraftHistory({
  query = '',
  toggleNav,
}: {
  query?: string;
  toggleNav: () => void;
}) {
  const { user } = useAuthContext();
  const enabled = useRecoilValue(store.saveDrafts);
  const owner = user?.id ?? '';
  const { newConversation } = useNewConvo();
  const [snapshot, setSnapshot] = useState<{ owner: string; drafts: ChatDraft[] }>({
    owner: '',
    drafts: [],
  });
  const [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => {
      if (!owner || !enabled) {
        setSnapshot({ owner, drafts: [] });
        return;
      }
      try {
        setSnapshot({ owner, drafts: listChatDrafts(owner) });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Entwürfe konnten nicht geladen werden.');
      }
    };
    const failed = (event: Event) => setError((event as CustomEvent<string>).detail);
    refresh();
    window.addEventListener(DRAFTS_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener(DRAFT_ERROR, failed);
    return () => {
      window.removeEventListener(DRAFTS_CHANGED, refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener(DRAFT_ERROR, failed);
    };
  }, [owner, enabled]);
  const open = (draftId: string) => {
    if (!owner) return;
    if (activeDraftId(owner) === draftId && window.location.pathname === '/c/new') {
      requestChatFocus();
      toggleNav();
      return;
    }
    if (!requestDraftArchive()) return;
    try {
      const draft = readChatDraft(owner, draftId);
      if (!draft) return;
      localStorage.setItem(
        LocalStorageKeys.TEXT_DRAFT + Constants.NEW_CONVO,
        encodeBase64(draft.text),
      );
      localStorage.setItem(
        LocalStorageKeys.FILES_DRAFT + Constants.NEW_CONVO,
        JSON.stringify(draft.fileIds),
      );
      selectChatDraft(owner, draft.id);
      newConversation({ template: draft.setup, preset: draft.setup, restoreDraftId: draft.id });
      toggleNav();
      setError('');
    } catch (cause) {
      reportDraftError(cause);
    }
  };
  const drafts = snapshot.owner === owner ? snapshot.drafts : [];
  const visible = drafts.filter(
    (draft) => !query || draft.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  if (!visible.length && !error) return null;
  return (
    <section aria-label="Chat-Entwürfe" className="shrink-0 px-3 pb-2">
      {error && (
        <p role="alert" className="px-2 py-2 text-xs text-text-primary">
          {error}
        </p>
      )}
      {visible.length > 0 && (
        <>
          <h3 className="px-2 py-2 text-xs font-medium text-text-secondary">
            Entwürfe · {visible.length}
          </h3>
          <ul className="max-h-56 overflow-y-auto">
            {visible.map((draft) => (
              <li
                key={draft.id}
                className="group flex items-center rounded-lg hover:bg-surface-hover"
              >
                <button
                  type="button"
                  onClick={() => open(draft.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm"
                  title="Diesen Entwurf fortsetzen"
                >
                  <FilePenLine className="size-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {draft.text.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Entwurf mit Dateien'}
                    </span>
                    <span className="text-xs text-text-secondary">
                      Entwurf{draft.fileIds.length > 0 ? ` · ${draft.fileIds.length} Anhänge` : ''}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Entwurf löschen"
                  className="rounded p-2 text-text-secondary hover:text-text-primary"
                  onClick={() => {
                    if (window.confirm('Diesen lokalen Entwurf endgültig löschen?')) {
                      try {
                        if (activeDraftId(owner) === draft.id && !requestDraftArchive()) return;
                        removeChatDraft(owner, draft.id);
                      } catch (cause) {
                        reportDraftError(cause);
                      }
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
          <p className="px-2 pt-1 text-[10px] text-text-secondary">
            Für dieses Konto in diesem Browser gespeichert.
          </p>
        </>
      )}
    </section>
  );
}
