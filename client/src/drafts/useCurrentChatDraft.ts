import { useEffect, useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRecoilValue } from 'recoil';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import type { TConversation, TFile } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import { useChatFormContext } from '~/Providers';
import { useGetFiles } from '~/data-provider';
import { encodeBase64 } from '~/utils/drafts';
import store from '~/store';
import {
  ARCHIVE_NEW_CHAT,
  activeDraftId,
  readChatDraft,
  reportDraftError,
  saveChatDraft,
  removeChatDraft,
  selectChatDraft,
} from './history';

type Props = {
  index: number;
  conversation: TConversation | null;
  isSubmitting: boolean;
  isTemporary: boolean;
  answerDraftId?: string | null;
  textAreaRef: React.RefObject<HTMLTextAreaElement>;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
};
export default function useCurrentChatDraft(props: Props) {
  const user = useRecoilValue(store.user);
  const enabled = useRecoilValue(store.saveDrafts);
  const { setValue } = useChatFormContext();
  const { data: fileList } = useGetFiles<TFile[]>();
  const [params] = useSearchParams();
  const owner = user?.id ?? '';
  const id = params.get('draft') || activeDraftId(owner);
  const latest = useRef({ ...props, owner, enabled, selectedId: id });
  latest.current = { ...props, owner, enabled, selectedId: id };
  const committed = useRef(latest.current);
  useLayoutEffect(() => {
    committed.current = latest.current;
  });
  useLayoutEffect(
    () => () => {
      const current = committed.current;
      if (
        current.index !== 0 ||
        !current.owner ||
        !current.enabled ||
        current.isTemporary ||
        current.isSubmitting ||
        current.answerDraftId ||
        current.conversation?.conversationId !== Constants.NEW_CONVO
      )
        return;
      try {
        if (current.selectedId && !readChatDraft(current.owner, current.selectedId)) return;
        const saved = saveChatDraft(current.owner, {
          id: current.selectedId,
          text: current.textAreaRef.current?.value ?? '',
          fileIds: [...current.files.keys()],
          setup: current.conversation,
        });
        if (saved) selectChatDraft(current.owner, saved.id);
      } catch (error) {
        reportDraftError(error);
      }
    },
    [owner, id, props.index, props.conversation?.conversationId],
  );
  const restored = useRef('');
  const restoredFiles = useRef('');

  useEffect(() => {
    if (props.index !== 0) return;
    const archive = (event: Event) => {
      const current = latest.current;
      if (
        !current.owner ||
        current.isSubmitting ||
        current.answerDraftId ||
        current.conversation?.conversationId !== Constants.NEW_CONVO
      )
        return;
      try {
        if (current.enabled && !current.isTemporary) {
          const selected = activeDraftId(current.owner);
          const saved = saveChatDraft(current.owner, {
            id: selected,
            text: current.textAreaRef.current?.value ?? '',
            fileIds: [...current.files.keys()],
            setup: current.conversation,
          });
          if (!saved && selected) removeChatDraft(current.owner, selected);
        }
        current.setFiles(new Map());
        committed.current = { ...current, files: new Map() };
        selectChatDraft(current.owner, null);
        localStorage.removeItem(LocalStorageKeys.TEXT_DRAFT + Constants.NEW_CONVO);
        localStorage.removeItem(LocalStorageKeys.FILES_DRAFT + Constants.NEW_CONVO);
        setValue('text', '');
        if (current.textAreaRef.current) current.textAreaRef.current.value = '';
      } catch (error) {
        event.preventDefault();
        reportDraftError(error);
      }
    };
    window.addEventListener(ARCHIVE_NEW_CHAT, archive);
    return () => window.removeEventListener(ARCHIVE_NEW_CHAT, archive);
  }, [props.index, setValue]);

  useEffect(() => {
    if (
      !owner ||
      !id ||
      props.index !== 0 ||
      props.conversation?.conversationId !== Constants.NEW_CONVO ||
      props.isSubmitting ||
      props.answerDraftId ||
      props.isTemporary
    )
      return;
    const token = owner + ':' + id;
    try {
      const draft = readChatDraft(owner, id);
      if (!draft) return;
      selectChatDraft(owner, draft.id);
      if (restored.current !== token) {
        localStorage.setItem(
          LocalStorageKeys.TEXT_DRAFT + Constants.NEW_CONVO,
          encodeBase64(draft.text),
        );
        localStorage.setItem(
          LocalStorageKeys.FILES_DRAFT + Constants.NEW_CONVO,
          JSON.stringify(draft.fileIds),
        );
        setValue('text', draft.text);
        restored.current = token;
      }
      if (fileList && restoredFiles.current !== token) {
        const files = new Map<string, ExtendedFile>();
        for (const fileId of draft.fileIds) {
          const file = fileList.find(
            (item) => item.file_id === fileId || item.temp_file_id === fileId,
          );
          if (file) files.set(fileId, { ...file, progress: 1, attached: true, size: file.bytes });
        }
        props.setFiles(files);
        restoredFiles.current = token;
        if (files.size !== draft.fileIds.length)
          reportDraftError(
            new Error(
              'Einige Entwurfsanhänge sind nicht mehr verfügbar. Bitte vor dem Senden erneut anhängen.',
            ),
          );
      }
    } catch (error) {
      reportDraftError(error);
    }
  }, [
    owner,
    id,
    props.index,
    props.conversation?.conversationId,
    props.isSubmitting,
    props.answerDraftId,
    props.isTemporary,
    props.setFiles,
    fileList,
    setValue,
  ]);

  useEffect(() => {
    if (!id) {
      restored.current = '';
      restoredFiles.current = '';
    }
    const textarea = props.textAreaRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const current = latest.current;
      const selected = activeDraftId(current.owner);
      if (
        !current.owner ||
        !selected ||
        !current.enabled ||
        current.isTemporary ||
        current.isSubmitting ||
        current.answerDraftId ||
        current.conversation?.conversationId !== Constants.NEW_CONVO
      )
        return;
      try {
        if (!readChatDraft(current.owner, selected)) return;
        saveChatDraft(current.owner, {
          id: selected,
          text: current.textAreaRef.current?.value ?? '',
          fileIds: [...current.files.keys()],
          setup: current.conversation,
        });
      } catch (error) {
        reportDraftError(error);
      }
    };
    const input = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 150);
    };
    textarea?.addEventListener('input', input);
    window.addEventListener('pagehide', update);
    return () => {
      clearTimeout(timer);
      textarea?.removeEventListener('input', input);
      window.removeEventListener('pagehide', update);
    };
  }, [id, props.textAreaRef]);
}
