import type { MailFetch, MailGraph, MailMessage, MailFolder } from './types';
import { createDraftOperations } from './drafts';
import { createPreviewOperation } from './preview';
import { MailGraphError } from './errors';
export { MailGraphError } from './errors';

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
    parentFolderId: text(value.parentFolderId, 2048),
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
  async function raw(
    path: string,
    method = 'GET',
    body?: unknown,
    etag?: string,
    format: 'text' | 'html' = 'text',
    timeout?: number,
  ): Promise<Response> {
    await beforeRequest();
    const accessToken = await token();
    await beforeRequest();
    let response: Response;
    try {
      response = await request(origin + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeout ?? (path.endsWith('/$value') ? 300_000 : 25_000)),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: path.endsWith('/$value') ? '*/*' : 'application/json',
          Prefer: `IdType="ImmutableId", outlook.body-content-type="${format}"`,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
          ...(etag && { 'If-Match': etag }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new MailGraphError(0, method !== 'GET');
    }
    if (!response.ok)
      throw new MailGraphError(response.status, method !== 'GET' && response.status >= 500);
    return response;
  }
  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    etag?: string,
    format: 'text' | 'html' = 'text',
    timeout?: number,
  ): Promise<Record<string, unknown>> {
    const response = await raw(path, method, body, etag, format, timeout);
    if (response.status === 204) return {};
    try {
      if (!response.body) throw Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 10_000_000) throw Error();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error();
      return result;
    } catch {
      throw new MailGraphError(502, method !== 'GET');
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
      // eslint-disable-next-line no-control-regex -- Reject control bytes before URL normalization.
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
    if (
      !value ||
      value.length > 2048 ||
      value === '.' ||
      value === '..' ||
      // eslint-disable-next-line no-control-regex -- Opaque IDs must not contain control bytes.
      /[\r\n\\\u0000-\u001f]/.test(value)
    )
      throw new MailGraphError(400);
    return encodeURIComponent(value);
  };
  const reservedFolderAliases = [
    'inbox',
    'deleteditems',
    'drafts',
    'sentitems',
    'junkemail',
    'outbox',
    'msgfolderroot',
  ];
  let reservedFolders: Promise<Set<string>> | undefined;
  const systemFolderIdentities = new Map<string, string>();
  async function systemFolderIds() {
    if (!reservedFolders) {
      reservedFolders = (async () => {
        const values = new Set<string>();
        // The OAuth layer coalesces refreshes; every read still runs its own owner guard.
        for (let offset = 0; offset < reservedFolderAliases.length; offset += 3) {
          const group = reservedFolderAliases.slice(offset, offset + 3);
          const folders = await Promise.all(
            group.map((alias) => call(`/v1.0/me/mailFolders/${alias}?$select=id`)),
          );
          for (const [index, folder] of folders.entries()) {
            if (typeof folder.id !== 'string' || !folder.id) throw new MailGraphError(502);
            values.add(folder.id);
            systemFolderIdentities.set(group[index], folder.id);
          }
        }
        return values;
      })();
    }
    return reservedFolders;
  }
  const folderFields = 'id,displayName,parentFolderId,childFolderCount,isHidden';
  function parseFolder(value: Record<string, unknown>, reserved: Set<string>): MailFolder {
    if (
      typeof value.id !== 'string' ||
      !value.id ||
      value.id.length > 2048 ||
      typeof value.displayName !== 'string' ||
      value.displayName.length > 255 ||
      !Number.isSafeInteger(value.childFolderCount) ||
      (value.childFolderCount as number) < 0 ||
      value.isHidden === true ||
      (typeof value['@odata.type'] === 'string' &&
        !['#microsoft.graph.mailFolder', 'microsoft.graph.mailFolder'].includes(
          value['@odata.type'],
        ))
    )
      throw new MailGraphError(400);
    return {
      id: value.id,
      displayName: value.displayName,
      ...(typeof value.parentFolderId === 'string' && { parentFolderId: value.parentFolderId }),
      childFolderCount: value.childFolderCount as number,
      canMoveTo:
        !reserved.has(value.id) &&
        (!value.parentFolderId ||
          !reserved.has(String(value.parentFolderId)) ||
          value.parentFolderId === systemFolderIdentities.get('inbox') ||
          value.parentFolderId === systemFolderIdentities.get('msgfolderroot')),
    };
  }
  async function targetFolder(value: string): Promise<MailFolder> {
    if (
      reservedFolderAliases.includes(value.toLowerCase()) ||
      otherFolderAliases.has(value.toLowerCase())
    )
      throw new MailGraphError(400);
    const reserved = await systemFolderIds();
    const current = parseFolder(
      await call(`/v1.0/me/mailFolders/${id(value)}?$select=${folderFields}`),
      reserved,
    );
    if (current.id !== value || !current.canMoveTo) throw new MailGraphError(400);
    const visited = new Set([current.id]);
    let parentId = current.parentFolderId;
    for (let depth = 0; depth < 20; depth++) {
      if (parentId === systemFolderIdentities.get('msgfolderroot')) return current;
      if (
        !parentId ||
        visited.has(parentId) ||
        (reserved.has(parentId) && parentId !== systemFolderIdentities.get('inbox'))
      )
        throw new MailGraphError(400);
      visited.add(parentId);
      const parent = await call(
        `/v1.0/me/mailFolders/${id(parentId)}?$select=id,parentFolderId,isHidden`,
      );
      if (
        parent.id !== parentId ||
        parent.isHidden === true ||
        typeof parent.parentFolderId !== 'string'
      )
        throw new MailGraphError(400);
      parentId = parent.parentFolderId;
    }
    throw new MailGraphError(400);
  }
  function folderPagePath(link: string, path: string): string {
    try {
      // eslint-disable-next-line no-control-regex -- Reject control bytes before URL normalization.
      if (/[\\\u0000-\u0020\u007f]/.test(link)) throw Error();
      const raw = /^https:\/\/graph\.microsoft\.com(\/[^?#]*)(\?[^#]*)?$/.exec(link);
      const url = new URL(link);
      if (
        !raw ||
        raw[1] !== url.pathname ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.hash
      )
        throw Error();
      const normalize = (value: string) =>
        decodeURIComponent(value).replace(/\/mailfolders\('([^'/]+)'\)/i, '/mailFolders/$1');
      if (normalize(url.pathname) !== normalize(path)) throw Error();
      return url.pathname + url.search;
    } catch {
      throw new MailGraphError(400);
    }
  }
  return {
    preview: createPreviewOperation({
      call,
      raw: (path, timeout) => raw(path, 'GET', undefined, undefined, 'text', timeout),
      id,
      beforeRequest,
    }),
    async folders(parentId) {
      const path = parentId
        ? `/v1.0/me/mailFolders/${id(parentId)}/childFolders`
        : '/v1.0/me/mailFolders';
      const reserved = await systemFolderIds();
      if (parentId && reserved.has(parentId) && parentId !== systemFolderIdentities.get('inbox'))
        throw new MailGraphError(400);
      const folders: MailFolder[] = [];
      const seen = new Set<string>();
      let next: string | undefined = `${path}?$select=${folderFields}&$top=100`;
      while (next) {
        if (seen.has(next) || seen.size >= 10) throw new MailGraphError(502);
        seen.add(next);
        const page = await call(next);
        if (!Array.isArray(page.value)) throw new MailGraphError(502);
        for (const value of page.value) {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new MailGraphError(502);
          if (value.isHidden === true || /mailSearchFolder/i.test(String(value['@odata.type'])))
            continue;
          folders.push(parseFolder(value, reserved));
          if (folders.length > 1_000) throw new MailGraphError(502);
        }
        const link = page['@odata.nextLink'];
        if (link !== undefined && typeof link !== 'string') throw new MailGraphError(502);
        next = typeof link === 'string' ? folderPagePath(link, path) : undefined;
      }
      return folders;
    },
    folder: targetFolder,
    async move(value, folderId, etag) {
      if (!etag || !/^(?:W\/)?"[^\r\n"]{1,2048}"$/.test(etag)) throw new MailGraphError(412);
      const target = await targetFolder(folderId);
      const current = message(await call(`/v1.0/me/messages/${id(value)}?$select=${fields}`));
      if (current.id !== value || current.isDraft || current.etag !== etag)
        throw new MailGraphError(409);
      if (current.parentFolderId === target.id) return current;
      const moved = await call(
        `/v1.0/me/messages/${id(value)}/move`,
        'POST',
        { destinationId: target.id },
        etag,
      );
      try {
        const result = message(moved);
        if (
          result.id !== value ||
          result.conversationId !== current.conversationId ||
          result.isDraft ||
          result.parentFolderId !== target.id
        )
          throw new MailGraphError(502, true);
        return result;
      } catch {
        throw new MailGraphError(502, true);
      }
    },
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
    ...createDraftOperations({
      call,
      raw: (path) => raw(path),
      request,
      beforeRequest,
      id,
      safeOutlookUrl,
    }),
  };
}
