import { v4 as uuid } from 'uuid';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';

export const DRAFTS_CHANGED = 'kisuno:chat-drafts-changed';
export const ARCHIVE_NEW_CHAT = 'kisuno:archive-new-chat';
export const DRAFT_ERROR = 'kisuno:chat-draft-error';
const PREFIX = 'kisuno.chat-draft.v1:';
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
const setupKeys = [
  'spec',
  'endpoint',
  'endpointType',
  'model',
  'agent_id',
  'assistant_id',
  'chatProjectId',
] as const;
export type ChatDraft = {
  id: string;
  text: string;
  fileIds: string[];
  setup: Partial<TConversation>;
  createdAt: number;
  updatedAt: number;
};
const scope = (owner: string) => {
  if (!owner || owner.length > 160) throw new Error('Das Entwurfskonto ist nicht bestätigt.');
  return PREFIX + encodeURIComponent(owner) + ':';
};
function parse(raw: string, id: string): ChatDraft {
  let value: ChatDraft;
  try {
    value = JSON.parse(raw) as ChatDraft;
  } catch {
    throw new Error('Ein gespeicherter Entwurf ist beschädigt. Er wird nicht überschrieben.');
  }
  if (
    !value ||
    value.id !== id ||
    !validId(id) ||
    typeof value.text !== 'string' ||
    value.text.length > 100000 ||
    !Array.isArray(value.fileIds) ||
    value.fileIds.length > 100 ||
    !value.fileIds.every((file) => typeof file === 'string' && /^[\w.:-]{1,160}$/.test(file)) ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.updatedAt) ||
    !value.setup ||
    typeof value.setup !== 'object'
  ) {
    throw new Error('Ein gespeicherter Entwurf ist beschädigt. Er wird nicht überschrieben.');
  }
  const setup: Partial<TConversation> = {};
  for (const key of setupKeys) {
    const entry = value.setup[key];
    if (typeof entry === 'string' && entry.length <= 200) Object.assign(setup, { [key]: entry });
  }
  return { ...value, setup };
}
export function readChatDraft(owner: string, id: string): ChatDraft | null {
  if (!validId(id)) return null;
  const raw = localStorage.getItem(scope(owner) + id);
  return raw ? parse(raw, id) : null;
}
export function listChatDrafts(owner: string): ChatDraft[] {
  const prefix = scope(owner);
  const result: ChatDraft[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    const raw = localStorage.getItem(key);
    if (raw) result.push(parse(raw, id));
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
export function saveChatDraft(
  owner: string,
  input: { id?: string | null; text: string; fileIds: string[]; setup?: Partial<TConversation> },
): ChatDraft | null {
  if (!input.text.trim() && !input.fileIds.length) return null;
  if (input.text.length > 100000 || input.fileIds.length > 100)
    throw new Error('Der Entwurf ist zu gross. Der Text bleibt im Eingabefeld erhalten.');
  const id = input.id && validId(input.id) ? input.id : uuid();
  const old = readChatDraft(owner, id);
  if (!old && listChatDrafts(owner).length >= 100)
    throw new Error('100 Entwürfe gespeichert. Bitte zuerst einen Entwurf entfernen.');
  const setup: Partial<TConversation> = {};
  for (const key of setupKeys) {
    const value = input.setup?.[key];
    if (typeof value === 'string' && value.length <= 200) Object.assign(setup, { [key]: value });
  }
  const now = Date.now();
  const draft = parse(
    JSON.stringify({
      id,
      text: input.text,
      fileIds: [...new Set(input.fileIds)],
      setup,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    }),
    id,
  );
  localStorage.setItem(scope(owner) + id, JSON.stringify(draft));
  window.dispatchEvent(new Event(DRAFTS_CHANGED));
  return draft;
}
export function removeChatDraft(owner: string, id: string) {
  if (!validId(id)) return;
  localStorage.removeItem(scope(owner) + id);
  if (sessionStorage.getItem('kisuno.active-draft:' + encodeURIComponent(owner)) === id)
    selectChatDraft(owner, null);
  window.dispatchEvent(new Event(DRAFTS_CHANGED));
}
export function activeDraftId(owner?: string): string | null {
  const id = new URLSearchParams(window.location.search).get('draft');
  if (id && validId(id)) return id;
  if (!owner) return null;
  const selected = sessionStorage.getItem('kisuno.active-draft:' + encodeURIComponent(owner));
  return selected && validId(selected) ? selected : null;
}
export function selectChatDraft(owner: string, id: string | null) {
  const key = 'kisuno.active-draft:' + encodeURIComponent(owner);
  if (id && validId(id)) sessionStorage.setItem(key, id);
  else sessionStorage.removeItem(key);
}
export function finishDraftNavigation(owner: string) {
  const id = sessionStorage.getItem('kisuno.active-draft:' + encodeURIComponent(owner));
  const draft = id ? readChatDraft(owner, id) : null;
  if (draft) {
    const raw = localStorage.getItem(LocalStorageKeys.TEXT_DRAFT + Constants.NEW_CONVO);
    // A matching native buffer is already durable in the owner-scoped record.
    if (!raw || raw === encodeText(draft.text)) {
      localStorage.removeItem(LocalStorageKeys.TEXT_DRAFT + Constants.NEW_CONVO);
      localStorage.removeItem(LocalStorageKeys.FILES_DRAFT + Constants.NEW_CONVO);
    }
  }
  selectChatDraft(owner, null);
}
function encodeText(text: string) {
  try {
    return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  } catch {
    return null;
  }
}
export function requestDraftArchive(): boolean {
  return window.dispatchEvent(new Event(ARCHIVE_NEW_CHAT, { cancelable: true }));
}
export function reportDraftError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : 'Der Entwurf konnte nicht gespeichert werden. Der Text bleibt erhalten.';
  window.dispatchEvent(new CustomEvent(DRAFT_ERROR, { detail: message }));
}

/** Keep the native single new-chat buffer from crossing an account boundary. */
export function setChatDraftOwner(owner?: string | null) {
  try {
    const key = 'kisuno.chat-draft.owner';
    const previous = localStorage.getItem(key);
    if (!owner || (previous && previous !== owner)) {
      requestDraftArchive();
      localStorage.removeItem(LocalStorageKeys.TEXT_DRAFT + Constants.NEW_CONVO);
      localStorage.removeItem(LocalStorageKeys.FILES_DRAFT + Constants.NEW_CONVO);
    }
    if (owner) localStorage.setItem(key, owner);
  } catch (error) {
    reportDraftError(error);
  }
}
