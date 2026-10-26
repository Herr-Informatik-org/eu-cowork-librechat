import type { MailFetch, MailGraph, MailMessage } from './types';

const origin = 'https://graph.microsoft.com';
const fields =
  'id,conversationId,changeKey,subject,from,receivedDateTime,sentDateTime,categories,isDraft,webLink,parentFolderId';
const otherFolderAliases = new Set([
  'archive',
  'clutter',
  'conflicts',
  'conversationhistory',
  'deleteditems',
  'drafts',
  'junkemail',
  'localfailures',
  'msgfolderroot',
  'outbox',
  'recoverableitemsdeletions',
  'scheduled',
  'searchfolders',
  'sentitems',
  'serverfailures',
  'syncissues',
]);
const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.slice(0, max) : '';

export class MailGraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly uncertain = false,
  ) {
    super(
      uncertain
        ? 'Ob der Entwurf angelegt wurde, ist unklar. Bitte prüfe Outlook; es erfolgt kein automatischer neuer Versuch.'
        : status === 401 || status === 403
          ? 'Microsoft verweigert den Zugriff. Bitte prüfe die persönliche Verbindung und Freigabe.'
          : status === 429
            ? 'Microsoft begrenzt die Anfragen. Die Verarbeitung pausiert bis zur nächsten Prüfung.'
            : 'Microsoft ist momentan nicht erreichbar. Bitte prüfe die Verbindung.',
    );
  }
}

class MailHistoryLinkError extends MailGraphError {
  constructor() {
    super(400);
    this.message =
      'Die nächste Posteingangsseite von Microsoft konnte nicht sicher geprüft werden. Bitte den Support kontaktieren.';
  }
}

export function safeOutlookUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'].includes(url.hostname)
    )
      return url.href;
  } catch {
    /* The original message remains available in Outlook. */
  }
  return undefined;
}

function message(value: Record<string, unknown>): MailMessage {
  const from = value.from as { emailAddress?: { address?: string } } | undefined;
  const body = value.body as { content?: string; contentType?: string } | undefined;
  const result: MailMessage = {
    id: text(value.id, 2048),
    conversationId: text(value.conversationId, 2048),
    changeKey: text(value.changeKey, 2048),
    subject: text(value.subject, 500),
    sender: text(from?.emailAddress?.address, 320),
    receivedAt: text(value.receivedDateTime, 40),
    sentAt: text(value.sentDateTime, 40),
    body: text(body?.content, 12_000),
    bodyTruncated: typeof body?.content === 'string' && body.content.length > 12_000,
    etag: typeof value['@odata.etag'] === 'string' ? value['@odata.etag'] : undefined,
    categories: Array.isArray(value.categories)
      ? value.categories.filter((v): v is string => typeof v === 'string')
      : [],
    isDraft: value.isDraft === true,
    messageUrl: safeOutlookUrl(value.webLink),
  };
  if (!result.id || !result.conversationId || !Number.isFinite(Date.parse(result.receivedAt)))
    throw new MailGraphError(502);
  return result;
}

/** Only fixed /me operations are exposed; there is deliberately no generic request or send API. */
export function createMailGraph({
  token,
  beforeRequest,
  fetch: request = globalThis.fetch,
}: {
  token: () => Promise<string>;
  beforeRequest: () => Promise<void>;
  fetch?: MailFetch;
}): MailGraph {
  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    etag?: string,
  ): Promise<Record<string, unknown>> {
    await beforeRequest();
    const accessToken = await token();
    await beforeRequest();
    let response: Response;
    try {
      response = await request(origin + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(etag && { 'If-Match': etag }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new MailGraphError(0, method === 'POST');
    }
    if (!response.ok)
      throw new MailGraphError(response.status, method === 'POST' && response.status >= 500);
    if (response.status === 204) return {};
    try {
      const result = (await response.json()) as Record<string, unknown>;
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error();
      return result;
    } catch {
      throw new MailGraphError(502, method === 'POST');
    }
  }
  function deltaPath(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new MailGraphError(400);
    }
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/v1\.0\/me\/(?:mailfolders\/[A-Za-z0-9_+=-]+|mailfolders\('[A-Za-z0-9_+=-]+'\))\/messages\/delta$/i.test(
        decodeURIComponent(url.pathname),
      )
    )
      throw new MailGraphError(400);
    return url.pathname + url.search;
  }
  function historyPath(value: string): string {
    try {
      if (/[\\\u0000-\u0020\u007f]/.test(value)) throw new MailHistoryLinkError();
      const raw = /^https:\/\/graph\.microsoft\.com(?::443)?(\/[^?#]*)(\?[^#]*)?$/i.exec(value);
      const url = new URL(value);
      if (
        !raw ||
        raw[1] !== url.pathname ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new MailHistoryLinkError();
      const path =
        /^\/v1\.0\/me\/mailfolders(?:\/([^/]+)|\((?:'|%27)(.+?)(?:'|%27)\))\/messages$/i.exec(
          raw[1],
        );
      if (!path) throw new MailHistoryLinkError();
      const folder = decodeURIComponent(path[1] ?? path[2]);
      if (!/^[A-Za-z0-9_+=-]+$/.test(folder) || otherFolderAliases.has(folder.toLowerCase()))
        throw new MailHistoryLinkError();
      // Only Graph responses and owner-bound encrypted checkpoints supply these opaque links.
      return raw[1] + (raw[2] ?? '');
    } catch {
      throw new MailHistoryLinkError();
    }
  }
  const id = (value: string) => {
    if (!value || value.length > 2048 || /[\r\n]/.test(value)) throw new MailGraphError(400);
    return encodeURIComponent(value);
  };
  return {
    async identity() {
      const value = await call('/v1.0/me?$select=id,mail,userPrincipalName');
      return {
        id: text(value.id, 128),
        mail: text(value.mail, 320),
        userPrincipalName: text(value.userPrincipalName, 320),
      };
    },
    async page(since, url) {
      if (!Number.isFinite(Date.parse(since))) throw new MailGraphError(400);
      const query = new URLSearchParams({
        $select: fields,
        $filter: `receivedDateTime ge ${new Date(since).toISOString()}`,
        $top: '20',
      });
      const value = await call(
        url ? deltaPath(url) : `/v1.0/me/mailFolders/inbox/messages/delta?${query}`,
      );
      if (!Array.isArray(value.value)) throw new MailGraphError(502);
      const next = value['@odata.nextLink'] ?? value['@odata.deltaLink'];
      if (typeof next !== 'string') throw new MailGraphError(502);
      deltaPath(next);
      return {
        messages: value.value.filter((row) => !row['@removed']).map(message),
        nextUrl: next,
        hasMore: typeof value['@odata.nextLink'] === 'string',
      };
    },
    async historyPage(from, until, url) {
      if (
        !Number.isFinite(Date.parse(until)) ||
        (from && (!Number.isFinite(Date.parse(from)) || Date.parse(from) >= Date.parse(until)))
      )
        throw new MailGraphError(400);
      const query = new URLSearchParams({
        $select: fields,
        $filter: `${from ? `receivedDateTime ge ${new Date(from).toISOString()} and ` : ''}receivedDateTime lt ${new Date(until).toISOString()}`,
        $orderby: 'receivedDateTime desc',
        $top: '20',
      });
      const value = await call(
        url ? historyPath(url) : `/v1.0/me/mailFolders/inbox/messages?${query}`,
      );
      if (!Array.isArray(value.value)) throw new MailGraphError(502);
      const next = value['@odata.nextLink'];
      if (next !== undefined && typeof next !== 'string') throw new MailGraphError(502);
      if (typeof next === 'string') historyPath(next);
      return {
        messages: value.value.filter((row) => !row['@removed']).map(message),
        ...(typeof next === 'string' && { nextUrl: next }),
        hasMore: typeof next === 'string',
      };
    },
    async message(value) {
      return message(await call(`/v1.0/me/messages/${id(value)}?$select=${fields},body`));
    },
    async thread(value) {
      id(value);
      const sentFolder = await call('/v1.0/me/mailFolders/sentitems?$select=id');
      if (typeof sentFolder.id !== 'string') throw new MailGraphError(502);
      const query = new URLSearchParams({
        $select: `${fields},body`,
        $filter: `conversationId eq '${value.replace(/'/g, "''")}'`,
        $top: '20',
      });
      const result = await call(`/v1.0/me/messages?${query}`);
      if (!Array.isArray(result.value)) throw new MailGraphError(502);
      return {
        messages: result.value.map((row) => ({
          ...message(row),
          sentByUser: row.parentFolderId === sentFolder.id,
        })),
        complete: !result['@odata.nextLink'],
      };
    },
    async categorize(value, categories, etag) {
      if (
        categories.length > 100 ||
        categories.some((category) => typeof category !== 'string' || category.length > 255)
      )
        throw new MailGraphError(400);
      if (!etag || !/^(?:W\/)?"[^\r\n"]{1,2048}"$/.test(etag)) throw new MailGraphError(412);
      await call(`/v1.0/me/messages/${id(value)}`, 'PATCH', { categories }, etag);
    },
    async createReply(value, draft) {
      if (!draft.trim() || draft.length > 12_000) throw new MailGraphError(400);
      const escape = (input: string) =>
        input
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      const content = draft
        .split(/\n\s*\n/)
        .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
        .join('');
      const result = await call(`/v1.0/me/messages/${id(value)}/createReply`, 'POST', {
        message: { body: { contentType: 'HTML', content } },
      });
      if (typeof result.id !== 'string' || result.isDraft !== true)
        throw new MailGraphError(502, true);
      return { id: result.id, url: safeOutlookUrl(result.webLink) };
    },
  };
}
