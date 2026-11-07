import { createHash } from 'node:crypto';
import { MailAssistantError } from './engine';
import { MAIL_CONSENT_VERSION } from './types';
import type { MailCodec } from './privateData';
import type {
  MailMessage,
  MailResult,
  MailResultPage,
  MailRuntimeAdapter,
  MailStore,
  StoredMailResult,
} from './types';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Cursor {
  version: 1;
  generation: string;
  revision: number;
  mailbox: string;
  scope: string;
  search: string;
  partner: string;
  folder: 'inbox' | 'sentitems';
  nextUrl?: string;
  expires: number;
}
export interface MailInbox {
  inbox(owner: string, cursor?: string): Promise<MailResultPage>;
  correspondence(
    owner: string,
    resultId: string,
    query: { cursor?: string; search?: string },
  ): Promise<MailResultPage>;
}

/** Lists metadata only. The explicit content, analysis and mutation routes stay separate. */
export function createMailInbox({
  store,
  adapter,
  codec,
  now = () => new Date(),
}: {
  store: MailStore;
  adapter: MailRuntimeAdapter;
  codec: MailCodec;
  now?: () => Date;
}): MailInbox {
  async function binding(owner: string) {
    await adapter.authorize(owner);
    const settings = await store.read(owner);
    if (!settings || settings.settings.consentVersion !== MAIL_CONSENT_VERSION)
      throw new MailAssistantError(
        'Bitte zuerst die persönliche Mailverarbeitung bestätigen und die Einstellungen speichern.',
      );
    const current = await adapter.connection(owner);
    if (!current.connected || !current.mailbox || !current.generation)
      throw new MailAssistantError('Bitte zuerst dein persönliches Microsoft-Postfach verbinden.');
    return {
      mailbox: current.mailbox,
      generation: current.generation,
      revision: settings.revision,
    };
  }
  function publicResult(value: StoredMailResult, mail: MailMessage): MailResult {
    return {
      id: value.id,
      mailboxLocation: mail.sentByUser ? 'sent' : 'inbox',
      subject: mail.subject,
      sender: mail.sender,
      receivedAt: mail.receivedAt,
      isRead: mail.isRead,
      hasAttachments: mail.hasAttachments,
      responseAction: mail.responseAction,
      responseActionAt: mail.responseActionAt,
      analysisStatus: value.analysisStatus ?? 'complete',
      priority: value.priority,
      action: value.action,
      summary: value.summary,
      reason: value.reason,
      questions: value.questions,
      draftStatus: value.operationPending ? 'uncertain' : value.draftStatus,
      messageUrl: mail.messageUrl,
      draftUrl: value.draftUrl,
      draftWarnings: value.draftWarnings,
      manualPriority: value.manualPriority,
      moveStatus: value.moveStatus,
      doneFolder: value.doneFolder,
      revision: digest([value.messageId, value.conversationId, value.sourceHash]),
    };
  }
  async function list(
    owner: string,
    cursorText?: string,
    resultId?: string,
    search = '',
  ): Promise<MailResultPage> {
    if (
      typeof search !== 'string' ||
      search.length > 160 ||
      (cursorText !== undefined && (typeof cursorText !== 'string' || cursorText.length > 40_000))
    )
      throw new MailAssistantError('Die Suchanfrage ist ungültig. Bitte die Übersicht neu laden.');
    const current = await binding(owner);
    const scope = resultId ? `correspondence:${resultId}` : 'inbox';
    let partner = '';
    if (resultId) {
      if (!/^[a-f0-9]{64}$/.test(resultId))
        throw new MailAssistantError('Diese Nachricht ist nicht verfügbar.');
      const result = await store.result(owner, resultId);
      if (
        !result ||
        (result.connectionGeneration && result.connectionGeneration !== current.generation)
      )
        throw new MailAssistantError(
          'Diese Nachricht gehört nicht zur aktuellen Verbindung. Bitte die Übersicht neu laden.',
        );
      partner = (result.correspondent || result.sender).trim().toLowerCase();
      if (
        !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(partner) ||
        partner.length > 320 ||
        partner === current.mailbox.toLowerCase()
      )
        throw new MailAssistantError(
          'Für diese Nachricht ist kein eindeutiger Kommunikationspartner verfügbar.',
        );
    }
    let cursor: Cursor = {
      version: 1,
      ...current,
      scope,
      search,
      partner,
      folder: 'inbox',
      expires: now().getTime() + 10 * 60_000,
    };
    if (cursorText) {
      try {
        const decoded = codec.open<Cursor>(owner, 'inbox-cursor', cursorText);
        if (
          !decoded ||
          decoded.version !== 1 ||
          decoded.generation !== current.generation ||
          decoded.revision !== current.revision ||
          decoded.mailbox !== current.mailbox ||
          decoded.scope !== scope ||
          decoded.search !== search ||
          decoded.partner !== partner ||
          !['inbox', 'sentitems'].includes(decoded.folder) ||
          (!resultId && decoded.folder !== 'inbox') ||
          !Number.isFinite(decoded.expires) ||
          decoded.expires <= now().getTime() ||
          decoded.expires > now().getTime() + 10 * 60_000 ||
          (decoded.nextUrl !== undefined &&
            (typeof decoded.nextUrl !== 'string' || decoded.nextUrl.length > 20_000))
        )
          throw Error();
        cursor = decoded;
      } catch {
        throw new MailAssistantError(
          'Diese Posteingangsseite ist abgelaufen oder passt nicht zur Verbindung. Bitte die Übersicht neu laden.',
        );
      }
    }
    const guard = async () => {
      const latest = await binding(owner);
      if (
        latest.generation !== current.generation ||
        latest.mailbox !== current.mailbox ||
        latest.revision !== current.revision
      )
        throw new MailAssistantError(
          'Die persönliche Verbindung wurde geändert. Bitte die Übersicht neu laden.',
        );
    };
    await adapter.audit(
      owner,
      resultId ? 'correspondence_metadata_requested' : 'inbox_metadata_requested',
      resultId,
    );
    await guard();
    const graph = await adapter.graph(owner, guard);
    if (!graph.inboxPage || (resultId && !graph.correspondencePage))
      throw new MailAssistantError('Die Posteingangsübersicht ist noch nicht verfügbar.');
    let page: { messages: MailMessage[]; nextUrl?: string; hasMore: boolean };
    const seen = new Set<string>();
    for (let scanned = 0; ; scanned++) {
      const pageKey = `${cursor.folder}:${cursor.nextUrl ?? ''}`;
      if (seen.has(pageKey))
        throw new MailAssistantError(
          'Microsoft hat dieselbe Seite erneut geliefert. Bitte erneut laden.',
        );
      seen.add(pageKey);
      page = resultId
        ? await graph.correspondencePage!(partner, cursor.folder, search, cursor.nextUrl)
        : await graph.inboxPage(cursor.nextUrl);
      if (
        page.messages.length > 50 ||
        page.hasMore !== !!page.nextUrl ||
        (page.nextUrl && page.nextUrl === cursor.nextUrl)
      )
        throw new MailAssistantError(
          'Microsoft hat keine gültige nächste Seite geliefert. Bitte erneut laden.',
        );
      await guard();
      // Skip at most five empty correspondence pages, then return a continuation to the caller.
      if (!resultId || page.messages.length || scanned >= 4) break;
      if (page.nextUrl) cursor = { ...cursor, nextUrl: page.nextUrl };
      else if (cursor.folder === 'inbox')
        cursor = { ...cursor, folder: 'sentitems', nextUrl: undefined };
      else break;
    }
    const previous = await store.results(owner);
    const messages = [...new Map(page.messages.map((mail) => [mail.id, mail])).values()];
    const proposed = messages.map((mail): StoredMailResult => {
      const old = previous.find((value) => value.messageId === mail.id);
      if (old) {
        if (old.connectionGeneration && old.connectionGeneration !== current.generation)
          throw new MailAssistantError(
            'Die gespeicherte Übersicht gehört zu einer früheren Verbindung. Bitte die persönliche Verbindung trennen und neu verbinden.',
          );
        return old;
      }
      return {
        id: digest([owner, 'message', mail.id]),
        messageId: mail.id,
        conversationId: mail.conversationId,
        connectionGeneration: current.generation,
        ...(partner && { correspondent: partner }),
        sourceHash: digest([mail.id, mail.changeKey, mail.subject, mail.sender, mail.receivedAt]),
        subject: mail.subject,
        sender: mail.sender,
        receivedAt: mail.receivedAt,
        mailboxLocation: mail.sentByUser ? 'sent' : 'inbox',
        analysisStatus: 'pending',
        isRead: mail.isRead,
        hasAttachments: mail.hasAttachments,
        responseAction: mail.responseAction,
        responseActionAt: mail.responseActionAt,
        priority: 'normal',
        action: 'review',
        summary: '',
        reason: 'Noch nicht analysiert.',
        questions: [],
        draftStatus: 'none',
        categoryApplied: false,
        messageUrl: mail.messageUrl,
      };
    });
    const saved = proposed.length ? await store.seedResults(owner, proposed) : [];
    await guard();
    if (
      saved.some(
        (value) => value.connectionGeneration && value.connectionGeneration !== current.generation,
      )
    )
      throw new MailAssistantError(
        'Die gespeicherte Übersicht gehört zu einer früheren Verbindung. Bitte die persönliche Verbindung trennen und neu verbinden.',
      );
    const results = messages.map((mail) => {
      const row = saved.find((value) => value.messageId === mail.id);
      if (!row)
        throw new MailAssistantError(
          'Die Nachricht konnte nicht sicher zugeordnet werden. Bitte erneut laden.',
        );
      return publicResult(row, mail);
    });
    await adapter.audit(
      owner,
      resultId ? 'correspondence_metadata_read' : 'inbox_metadata_read',
      resultId,
    );
    await guard();
    let continuation: Cursor | undefined;
    if (page.nextUrl) continuation = { ...cursor, nextUrl: page.nextUrl };
    else if (resultId && cursor.folder === 'inbox')
      continuation = { ...cursor, folder: 'sentitems', nextUrl: undefined };
    return {
      results,
      complete: !continuation,
      ...(continuation && { nextCursor: codec.seal(owner, 'inbox-cursor', continuation) }),
    };
  }
  return {
    inbox: (owner, cursor) => list(owner, cursor),
    correspondence: (owner, resultId, query) =>
      list(owner, query.cursor, resultId, query.search ?? ''),
  };
}
