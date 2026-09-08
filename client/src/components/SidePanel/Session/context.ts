import { ContentTypes } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';
import parseJsonField from '~/components/Chat/Messages/Content/Parts/parseJsonField';

export interface SessionContext {
  files: Partial<TFile>[];
  fileOrigins: Record<string, { shared: boolean; toolOutput: boolean }>;
  sources: { url: string; title: string; processed: boolean }[];
  skills: string[];
  tools: string[];
  messageIds: string[];
}

/** Derive references only from this conversation, never from the user's file catalog. */
export function collectSessionContext(messages: TMessage[]): SessionContext {
  const files = new Map<string, Partial<TFile>>();
  const skills = new Set<string>();
  const tools = new Set<string>();
  const fileOrigins: SessionContext['fileOrigins'] = {};
  const sources = new Map<string, SessionContext['sources'][number]>();
  const collectFile = (file: Partial<TFile>, origin: 'shared' | 'toolOutput') => {
    const key = file.file_id || file.filepath;
    if (!key) return;
    files.set(key, { ...files.get(key), ...file });
    const previous = fileOrigins[key];
    fileOrigins[key] = {
      shared: origin === 'shared' || previous?.shared === true,
      toolOutput: origin === 'toolOutput' || previous?.toolOutput === true,
    };
  };
  for (const message of messages) {
    for (const file of message.files ?? []) collectFile(file, 'shared');
    for (const attachment of message.attachments ?? []) {
      if (attachment.filename || attachment.filepath) {
        collectFile(
          {
            file_id: 'file_id' in attachment ? attachment.file_id : undefined,
            filename: attachment.filename,
            filepath: attachment.filepath,
            source: 'source' in attachment ? attachment.source : undefined,
            user: 'user' in attachment ? attachment.user : undefined,
          },
          'toolOutput',
        );
      }
      const search = attachment.web_search;
      for (const source of [...(search?.organic ?? []), ...(search?.topStories ?? [])]) {
        const url = safeSessionFileUrl(source.link);
        if (!url || !/^https?:/.test(url)) continue;
        sources.set(url, {
          url,
          title: source.title || new URL(url).hostname,
          processed: source.processed === true || sources.get(url)?.processed === true,
        });
      }
    }
    for (const name of message.manualSkills ?? []) skills.add(name);
    for (const name of message.alwaysAppliedSkills ?? []) skills.add(name);
    for (const part of message.content ?? []) {
      // Stream handlers write by index, so earlier parts may not have arrived yet.
      if (part == null) continue;
      if (part.type === ContentTypes.STEER) {
        for (const file of part.files ?? []) {
          collectFile(file, 'shared');
        }
      }
      if (part.type !== ContentTypes.TOOL_CALL) continue;
      const call = part.tool_call;
      if (!call) continue;
      if ('name' in call && typeof call.name === 'string') {
        tools.add(call.name);
        if (call.name === 'skill') {
          const name = parseJsonField(call.args, 'skillName');
          if (name) skills.add(name);
        }
      } else if ('function' in call) tools.add(call.function.name);
      else if ('type' in call) tools.add(call.type);
    }
  }
  return {
    files: [...files.values()],
    fileOrigins,
    sources: [...sources.values()],
    skills: [...skills],
    tools: [...tools],
    messageIds: messages.map((message) => message.messageId),
  };
}

export function safeSessionFileUrl(value?: string): string | undefined {
  if (!value || [...value].some((character) => character === '\\' || character.charCodeAt(0) < 32))
    return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}
