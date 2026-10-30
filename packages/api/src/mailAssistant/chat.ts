import { z } from 'zod';
import type {
  MailChatRequest,
  MailChatResponse,
  MailResultPage,
  MailRuntimeAdapter,
  MailStore,
} from './types';
import { MAIL_CONSENT_VERSION } from './types';
import { MailAssistantError, resultRevision } from './engine';

export const mailChatSchema: z.ZodType<MailChatRequest> = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    message: z.string().trim().min(1).max(4000),
    history: z
      .array(
        z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }).strict(),
      )
      .max(12),
    draft: z.string().max(12000).optional(),
    includeCorrespondence: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 24000,
    'Der Chat ist zu lang. Bitte einen neuen Mail-Chat starten.',
  );

/** Context is read on behalf of the owner; the model never receives mailbox tools or credentials. */
export function createMailChat({
  store,
  adapter,
  correspondence,
}: {
  store: MailStore;
  adapter: MailRuntimeAdapter;
  correspondence: (
    owner: string,
    id: string,
    query: { search?: string; cursor?: string },
  ) => Promise<MailResultPage>;
}) {
  const pending = new Set<string>();
  return async (owner: string, id: string, input: MailChatRequest): Promise<MailChatResponse> => {
    const parsed = mailChatSchema.parse(input);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new MailAssistantError('Mail-Vorgang nicht gefunden.');
    await adapter.authorize(owner);
    if (pending.has(owner))
      throw new MailAssistantError('Deine vorige Chatantwort wird noch vorbereitet.');
    pending.add(owner);
    try {
      const [job, connection, result, model] = await Promise.all([
        store.read(owner),
        adapter.connection(owner),
        store.result(owner, id),
        adapter.availability(owner),
      ]);
      if (!result || resultRevision(result) !== parsed.revision)
        throw new MailAssistantError('Die Mail wurde geändert. Bitte neu laden.');
      if (
        job?.settings.consentVersion !== MAIL_CONSENT_VERSION ||
        !connection.connected ||
        !connection.generation ||
        !connection.mailbox ||
        !model.available ||
        !adapter.chat
      )
        throw new MailAssistantError(
          'Bitte zuerst dein eigenes Postfach verbinden und die persönliche Verarbeitung freigeben.',
        );
      const generation = connection.generation;
      const mailbox = connection.mailbox;
      const revision = job.revision;
      if (result.connectionGeneration && result.connectionGeneration !== generation)
        throw new MailAssistantError(
          'Bitte den Posteingang nach dem Verbindungswechsel neu laden.',
        );
      const guard = async () => {
        await adapter.authorize(owner);
        const [latest, current, selected] = await Promise.all([
          store.read(owner),
          adapter.connection(owner),
          store.result(owner, id),
        ]);
        if (
          !latest ||
          latest.revision !== revision ||
          latest.settings.consentVersion !== MAIL_CONSENT_VERSION ||
          !current.connected ||
          current.generation !== generation ||
          current.mailbox !== mailbox ||
          !selected ||
          resultRevision(selected) !== parsed.revision
        )
          throw new MailAssistantError(
            'Deine Freigabe, Mail oder Verbindung wurde geändert. Bitte den Chat erneut öffnen.',
          );
      };
      await guard();
      await adapter.audit(owner, 'mail_chat_requested', id);
      const graph = await adapter.graph(owner, guard);
      const original = await graph.message(result.messageId);
      if (
        original.id !== result.messageId ||
        original.conversationId !== result.conversationId ||
        original.isDraft
      )
        throw new MailAssistantError('Die Mail passt nicht mehr zum ausgewählten Vorgang.');
      const sources: MailResultPage['results'] = [];
      const messages = [original];
      if (parsed.includeCorrespondence) {
        const candidates: MailResultPage['results'] = [];
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
          const page = await correspondence(owner, id, { cursor });
          candidates.push(
            ...page.results.filter((item) => !candidates.some((old) => old.id === item.id)),
          );
          cursor = page.nextCursor;
          if (!cursor || candidates.length >= 8) break;
          await guard();
        }
        for (const source of candidates.slice(0, 8)) {
          if (source.id === id) continue;
          const stored = await store.result(owner, source.id);
          if (
            !stored ||
            stored.messageId === original.id ||
            (stored.connectionGeneration && stored.connectionGeneration !== generation)
          )
            continue;
          await guard();
          const mail = await graph.message(stored.messageId);
          if (
            mail.id !== stored.messageId ||
            mail.conversationId !== stored.conversationId ||
            mail.isDraft
          )
            continue;
          if (JSON.stringify([...messages, mail]).length > 32000) break;
          messages.push(mail);
          sources.push(source);
        }
      }
      await guard();
      const generated = await adapter.chat(owner, messages, parsed, guard);
      const answer = z
        .string()
        .trim()
        .min(1)
        .max(12000)
        .parse(typeof generated === 'string' ? generated : generated.text);
      await guard();
      await adapter.audit(owner, 'mail_chat_completed', id);
      return {
        answer,
        modelLabel: model.modelLabel,
        sources,
        ...(typeof generated !== 'string'
          ? { memory: generated.memory, learning: generated.learning }
          : {}),
      };
    } finally {
      pending.delete(owner);
    }
  };
}
