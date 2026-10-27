import sanitizeHtml from 'sanitize-html';
import { randomUUID } from 'node:crypto';
import type { MailFetch, MailSignature } from './types';
import { MailDraftError, MailGraphError } from './errors';
import { renderMailSignature, sanitizeMailSignature } from './signature';

type GraphCall = (
  path: string,
  method?: string,
  body?: unknown,
  etag?: string,
  format?: 'text' | 'html',
) => Promise<Record<string, unknown>>;

interface Attachment {
  id: string;
  type: string;
  name: string;
  size: number;
  contentType: string;
  contentId?: string;
  inline: boolean;
}

const replyStart = '<!-- kisuno-mail-reply:v2 -->';
const replyEnd = '<!-- /kisuno-mail-reply:v2 -->';
const oldReplyStart = '<!-- kisuno-mail-reply:v1 -->';
const oldReplyEnd = '<!-- /kisuno-mail-reply:v1 -->';
function replyStyle(
  fontFamily: MailSignature['fontFamily'],
  fontSize: MailSignature['fontSize'],
): string {
  return `margin:0 0 12pt 0;font-family:${fontFamily},Arial,sans-serif;font-size:${fontSize}pt;line-height:1.35;color:#000000`;
}
const defaultReplyStyle = replyStyle('Calibri', 11);
const replyStyles = (['Aptos', 'Calibri', 'Arial'] as const).flatMap((font) =>
  ([10, 11, 12, 14] as const).map((size) => replyStyle(font, size)),
);
const maxBody = 2_000_000;
const directUploadLimit = 3_000_000;
const uploadChunkSize = 3_000_000;
const maxAttachmentSize = 150_000_000;
const maxTotalSize = 150_000_000;
const maxAttachmentCount = 100;
const etagPattern = /^(?:W\/)?"[^\r\n"]{1,2048}"$/;
const incomplete =
  'Der Entwurf ist noch unvollständig. Bitte prüfe Text, Verlauf und Anhänge in Outlook. Es wird kein zweiter Entwurf automatisch angelegt.';

function requiredText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) throw new MailGraphError(502);
  return value;
}

function normalizeReply(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .join('\n\n');
}

function replyHtml(text: string, style = defaultReplyStyle): string {
  if (!text.trim() || text.length > 12_000) throw new MailGraphError(400);
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  return normalizeReply(text)
    .split(/\n\s*\n/)
    .map((paragraph) => `<p style="${style}">${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function draftBody(value: Record<string, unknown>, expectedId: string): string {
  if (value.id !== expectedId || value.isDraft !== true) throw new MailGraphError(409);
  const body = value.body as { content?: string; contentType?: string } | undefined;
  if (body?.contentType?.toLowerCase() !== 'html')
    throw new MailDraftError(
      'Der Entwurf lässt sich nicht sicher bearbeiten. Bitte öffne ihn in Outlook.',
    );
  return requiredText(body.content, maxBody);
}

function draftEtag(value: Record<string, unknown>): string {
  const etag = value['@odata.etag'];
  if (typeof etag !== 'string' || !etagPattern.test(etag)) throw new MailGraphError(412);
  return etag;
}

function prependReply(body: string, text: string, signature: string, style: string): string {
  const opening = /<body\b[^>]*>/i.exec(body);
  const position = opening ? opening.index + opening[0].length : 0;
  return (
    body.slice(0, position) +
    replyStart +
    replyHtml(text, style) +
    replyEnd +
    signature +
    body.slice(position)
  );
}

function editableBlock(body: string): { start: number; end: number; text: string; style: string } {
  const starts = [body.indexOf(replyStart), body.indexOf(oldReplyStart)].filter(
    (value) => value >= 0,
  );
  const start = starts.length ? Math.min(...starts) : -1;
  const legacy = body.startsWith(oldReplyStart, start);
  const startMarker = legacy ? oldReplyStart : replyStart;
  const endMarker = legacy ? oldReplyEnd : replyEnd;
  const end = body.indexOf(endMarker, start + startMarker.length);
  const prefix = body.slice(0, start);
  if (start < 0 || end < 0 || (prefix.trim() && !/<body\b[^>]*>\s*$/i.test(prefix)))
    throw new MailDraftError(
      'Dieser Entwurf hat keinen unveränderten Antwortbereich. Bitte bearbeite ihn in Outlook; der Mailverlauf bleibt erhalten.',
    );
  const html = body.slice(start + startMarker.length, end);
  const normalizedStyle = (style: string) =>
    style.toLowerCase().replace(/\s/g, '').split(';').filter(Boolean).sort().join(';');
  let modified = false;
  let selectedStyle: string | undefined;
  const plainHtml = sanitizeHtml(html, {
    allowedTags: ['p', 'br'],
    allowedAttributes: {},
    transformTags: {
      '*': (tagName, attribs) => {
        const keys = Object.keys(attribs);
        if (!['p', 'br'].includes(tagName)) modified = true;
        else if (legacy || tagName === 'br') modified ||= keys.length > 0;
        else {
          const allowed =
            keys.length === 1 && keys[0] === 'style'
              ? replyStyles.find(
                  (style) => normalizedStyle(style) === normalizedStyle(attribs.style),
                )
              : undefined;
          if (!allowed || (selectedStyle && selectedStyle !== allowed)) modified = true;
          else selectedStyle = allowed;
        }
        return { tagName, attribs: {} };
      },
    },
  });
  if (modified)
    throw new MailDraftError(
      'Der Antwortbereich wurde in Outlook formatiert. Bitte bearbeite ihn dort weiter.',
    );
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  };
  const text = plainHtml
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<\/?p>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity]);
  if (!text.trim() || text.length > 12_000) throw new MailGraphError(409);
  return { start, end: end + endMarker.length, text, style: selectedStyle ?? defaultReplyStyle };
}

function attachment(value: Record<string, unknown>): Attachment {
  const type = requiredText(value['@odata.type'], 100).replace(/^#/, '');
  const size = value.size;
  if (!Number.isSafeInteger(size) || (size as number) < 0) throw new MailGraphError(502);
  const contentId = value.contentId;
  if (contentId != null && (typeof contentId !== 'string' || contentId.length > 2048))
    throw new MailGraphError(502);
  return {
    id: requiredText(value.id, 2048),
    type,
    name: requiredText(value.name, 255),
    size: size as number,
    contentType:
      typeof value.contentType === 'string'
        ? value.contentType.slice(0, 255)
        : 'application/octet-stream',
    ...(typeof contentId === 'string' && contentId && { contentId }),
    inline: value.isInline === true,
  };
}

function collectionLink(link: string, expectedPath: string): string {
  try {
    // eslint-disable-next-line no-control-regex -- Reject control bytes before parsing untrusted Graph links.
    if (/[\\\u0000-\u0020\u007f]/.test(link)) throw Error();
    const raw = /^https:\/\/graph\.microsoft\.com(\/[^?#]*)(\?[^#]*)?$/.exec(link);
    const url = new URL(link);
    if (
      !raw ||
      raw[1] !== url.pathname ||
      url.origin !== 'https://graph.microsoft.com' ||
      url.username ||
      url.password ||
      url.hash ||
      decodeURIComponent(url.pathname) !== decodeURIComponent(expectedPath)
    )
      throw Error();
    return url.pathname + url.search;
  } catch {
    throw new MailGraphError(400);
  }
}

function uploadUrl(value: Record<string, unknown>): string {
  try {
    const raw = requiredText(value.uploadUrl, 16_384);
    const url = new URL(raw);
    if (
      // eslint-disable-next-line no-control-regex -- Upload targets must not contain control bytes.
      /[\\\u0000-\u0020\u007f]/.test(raw) ||
      !raw.startsWith('https://outlook.office.com/') ||
      url.origin !== 'https://outlook.office.com' ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/api\/(?:v1\.0|v2\.0|gv1\.0)\/users\('[^'/\\]+'\)\/messages\('[^'/\\]+'\)\/attachmentsessions\('[^'/\\]+'\)$/i.test(
        decodeURIComponent(url.pathname),
      ) ||
      !url.searchParams.get('authtoken') ||
      !Number.isFinite(Date.parse(String(value.expirationDateTime))) ||
      Date.parse(String(value.expirationDateTime)) <= Date.now() ||
      !Array.isArray(value.nextExpectedRanges) ||
      value.nextExpectedRanges.length !== 1 ||
      !['0', '0-'].includes(value.nextExpectedRanges[0])
    )
      throw Error();
    return raw;
  } catch {
    throw new MailDraftError(
      'Die sichere Übertragung grosser Anhänge konnte nicht gestartet werden. Bitte ergänze sie in Outlook.',
    );
  }
}

async function* chunks(response: Response, size: number): AsyncGenerator<Buffer> {
  if (!response.body) throw new MailGraphError(502);
  const reader = response.body.getReader();
  let pending = Buffer.alloc(0);
  let read = 0;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new MailGraphError(0)), 25_000);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (next.done) break;
      read += next.value.byteLength;
      if (read > size || read > maxAttachmentSize) throw new MailGraphError(502);
      let incoming = Buffer.from(next.value);
      while (incoming.length) {
        const take = Math.min(uploadChunkSize - pending.length, incoming.length);
        pending = Buffer.concat([pending, incoming.subarray(0, take)]);
        incoming = incoming.subarray(take);
        if (pending.length === uploadChunkSize) {
          yield pending;
          pending = Buffer.alloc(0);
        }
      }
    }
    if (read !== size) throw new MailGraphError(502);
    if (pending.length || size === 0) yield pending;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Attachments stay between the same mailbox's original and new draft, never in model input. */
export function createDraftOperations({
  call,
  raw,
  request,
  beforeRequest,
  id,
  safeOutlookUrl,
}: {
  call: GraphCall;
  raw: (path: string) => Promise<Response>;
  request: MailFetch;
  beforeRequest: () => Promise<void>;
  id: (value: string) => string;
  safeOutlookUrl: (value: unknown) => string | undefined;
}) {
  async function listAttachments(messageId: string): Promise<Attachment[]> {
    const path = `/v1.0/me/messages/${id(messageId)}/attachments`;
    let next: string | undefined =
      `${path}?$select=id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId&$top=100`;
    const result: Attachment[] = [];
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next) || seen.size >= 10) throw new MailGraphError(502);
      seen.add(next);
      const page = await call(next);
      if (!Array.isArray(page.value)) throw new MailGraphError(502);
      for (const row of page.value) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new MailGraphError(502);
        result.push(attachment(row));
        if (result.length > maxAttachmentCount)
          throw new MailDraftError(
            'Die Originalmail enthält mehr als 100 Anhänge. Bitte prüfe und übernimm sie in Outlook.',
          );
      }
      const link = page['@odata.nextLink'];
      if (link !== undefined && typeof link !== 'string') throw new MailGraphError(502);
      next = typeof link === 'string' ? collectionLink(link, path) : undefined;
    }
    return result;
  }
  async function readDraft(draftId: string) {
    const result = await call(
      `/v1.0/me/messages/${id(draftId)}?$select=id,isDraft,body,conversationId,changeKey`,
      'GET',
      undefined,
      undefined,
      'html',
    );
    return { result, body: draftBody(result, draftId), etag: draftEtag(result) };
  }
  async function assertDraft(draftId: string, expectedBody: string, conversationId: string) {
    const current = await readDraft(draftId);
    if (current.body !== expectedBody || current.result.conversationId !== conversationId)
      throw new MailDraftError(
        'Der Entwurf wurde inzwischen verändert. Bitte ergänze die übrigen Anhänge selbst in Outlook.',
      );
    return current;
  }
  async function copyFile(
    sourceId: string,
    draftId: string,
    file: Attachment,
    expectedBody: string,
    conversationId: string,
  ) {
    const response = await raw(
      `/v1.0/me/messages/${id(sourceId)}/attachments/${id(file.id)}/$value`,
    );
    const iterator = chunks(response, file.size);
    try {
      if (file.size < directUploadLimit) {
        const next = await iterator.next();
        if (next.done) throw new MailGraphError(502);
        const verified = await iterator.next();
        if (!verified.done) throw new MailGraphError(502);
        await assertDraft(draftId, expectedBody, conversationId);
        const result = await call(`/v1.0/me/messages/${id(draftId)}/attachments`, 'POST', {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: file.name,
          contentType: file.contentType,
          isInline: file.inline,
          ...(file.contentId && { contentId: file.contentId }),
          contentBytes: next.value.toString('base64'),
        });
        if (typeof result.id !== 'string') throw new MailGraphError(502, true);
        return;
      }
      await assertDraft(draftId, expectedBody, conversationId);
      const session = await call(
        `/v1.0/me/messages/${id(draftId)}/attachments/createUploadSession`,
        'POST',
        {
          AttachmentItem: {
            attachmentType: 'file',
            name: file.name,
            size: file.size,
            contentType: file.contentType,
            isInline: file.inline,
            ...(file.contentId && { contentId: file.contentId }),
          },
        },
      );
      const destination = uploadUrl(session);
      let offset = 0;
      for await (const part of iterator) {
        await assertDraft(draftId, expectedBody, conversationId);
        await beforeRequest();
        let uploaded: Response;
        try {
          uploaded = await request(destination, {
            method: 'PUT',
            redirect: 'error',
            signal: AbortSignal.timeout(25_000),
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(part.length),
              'Content-Range': `bytes ${offset}-${offset + part.length - 1}/${file.size}`,
            },
            body: new Uint8Array(part),
          });
        } catch {
          throw new MailGraphError(0, true);
        }
        offset += part.length;
        if (offset === file.size) {
          if (uploaded.status !== 201) throw new MailGraphError(uploaded.status, true);
          continue;
        }
        if (uploaded.status !== 200) throw new MailGraphError(uploaded.status, true);
        const state = (await uploaded.json().catch(() => null)) as {
          nextExpectedRanges?: string[];
        } | null;
        if (
          !state ||
          !Array.isArray(state.nextExpectedRanges) ||
          state.nextExpectedRanges.length !== 1 ||
          ![String(offset), `${offset}-`].includes(state.nextExpectedRanges[0])
        )
          throw new MailGraphError(502, true);
      }
      if (offset !== file.size) throw new MailGraphError(502, true);
    } finally {
      await iterator.return(undefined).catch(() => undefined);
    }
  }
  return {
    async editableReply(draftId: string) {
      const current = await readDraft(draftId);
      return { text: editableBlock(current.body).text, etag: current.etag };
    },
    async editDraft(draftId: string, text: string, etag: string) {
      replyHtml(text);
      if (!etagPattern.test(etag)) throw new MailGraphError(412);
      const current = await readDraft(draftId);
      if (current.etag !== etag) throw new MailGraphError(412);
      const block = editableBlock(current.body);
      const html = replyHtml(text, block.style);
      await call(
        `/v1.0/me/messages/${id(draftId)}`,
        'PATCH',
        {
          body: {
            contentType: 'HTML',
            content:
              current.body.slice(0, block.start) +
              replyStart +
              html +
              replyEnd +
              current.body.slice(block.end),
          },
        },
        etag,
        'html',
      );
    },
    async createReply(sourceId: string, text: string, signature?: MailSignature) {
      replyHtml(text);
      const preparedSignature = signature ? await sanitizeMailSignature(signature) : undefined;
      const signatureCid =
        preparedSignature?.enabled && preparedSignature.logo
          ? `kisuno-signature-${randomUUID()}`
          : undefined;
      const signatureHtml = renderMailSignature(preparedSignature, signatureCid);
      const style = preparedSignature
        ? replyStyle(preparedSignature.fontFamily, preparedSignature.fontSize)
        : defaultReplyStyle;
      const source = await call(
        `/v1.0/me/messages/${id(sourceId)}?$select=id,isDraft,conversationId,categories`,
      );
      if (
        source.id !== sourceId ||
        source.isDraft !== false ||
        typeof source.conversationId !== 'string'
      )
        throw new MailGraphError(409);
      const categories = source.categories;
      if (
        !Array.isArray(categories) ||
        categories.length > 100 ||
        categories.some((category) => typeof category !== 'string' || category.length > 255)
      )
        throw new MailGraphError(502);
      const files = await listAttachments(sourceId);
      const created = await call(
        `/v1.0/me/messages/${id(sourceId)}/createReply`,
        'POST',
        undefined,
        undefined,
        'html',
      );
      if (
        typeof created.id !== 'string' ||
        created.isDraft !== true ||
        created.conversationId !== source.conversationId
      )
        throw new MailGraphError(502, true);
      const result = { id: created.id, url: safeOutlookUrl(created.webLink) };
      const warnings: string[] = [];
      let stop = false;
      try {
        const initial = await readDraft(created.id);
        if (
          initial.result.conversationId !== source.conversationId ||
          initial.etag !== draftEtag(created)
        )
          throw new MailDraftError(
            'Der neue Entwurf wurde inzwischen verändert. Bitte bearbeite ihn in Outlook.',
          );
        let expectedBody = prependReply(initial.body, text, signatureHtml, style);
        const written = await call(
          `/v1.0/me/messages/${id(created.id)}`,
          'PATCH',
          {
            body: { contentType: 'HTML', content: expectedBody },
            categories,
          },
          initial.etag,
          'html',
        );
        if (written.id !== undefined) {
          expectedBody = draftBody(written, created.id);
          if (editableBlock(expectedBody).text !== normalizeReply(text))
            throw new MailGraphError(502);
        }
        if (preparedSignature?.logo && signatureCid) {
          await assertDraft(created.id, expectedBody, source.conversationId);
          const logo = await call(`/v1.0/me/messages/${id(created.id)}/attachments`, 'POST', {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'signatur-logo.png',
            contentType: 'image/png',
            isInline: true,
            contentId: signatureCid,
            contentBytes: preparedSignature.logo.contentBytes,
          });
          if (typeof logo.id !== 'string') throw new MailGraphError(502, true);
        }
        const existing = await listAttachments(created.id);
        let total = 0;
        for (const file of files) {
          if (file.type !== 'microsoft.graph.fileAttachment') {
            warnings.push(
              'Ein verknüpfter Cloud-Anhang oder angehängtes Outlook-Element wurde nicht kopiert. Bitte übernimm es bei Bedarf in Outlook.',
            );
            continue;
          }
          if (file.size > maxAttachmentSize || total + file.size > maxTotalSize) {
            warnings.push(
              'Anhänge über 150 MB oder über insgesamt 150 MB wurden nicht kopiert. Bitte ergänze sie in Outlook.',
            );
            continue;
          }
          total += file.size;
          if (
            file.inline &&
            file.contentId &&
            existing.some(
              (item) => item.inline && item.contentId === file.contentId && item.size === file.size,
            )
          )
            continue;
          await copyFile(sourceId, created.id, file, expectedBody, source.conversationId);
        }
        await assertDraft(created.id, expectedBody, source.conversationId);
      } catch (error) {
        if (!(error instanceof MailGraphError)) throw error;
        if ([401, 403].includes(error.status)) throw new MailGraphError(error.status, true);
        stop = !(error instanceof MailDraftError);
        warnings.push(error instanceof MailDraftError ? error.message : incomplete);
      }
      return {
        ...result,
        ...(warnings.length && { warnings: [...new Set(warnings)] }),
        ...(stop && { stop: true }),
      };
    },
  };
}
