import { ContentTypes, ToolCallTypes, FileSources } from 'librechat-data-provider';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import { collectSessionContext, safeSessionFileUrl } from './context';

function message(fields: Partial<TMessage>): TMessage {
  return {
    messageId: 'one',
    conversationId: 'current',
    parentMessageId: null,
    text: '',
    isCreatedByUser: true,
    ...fields,
  };
}

describe('session references', () => {
  test('deduplicates files and skills across turns, including steered files', () => {
    const file = {
      file_id: 'one-file',
      filename: 'offer.xlsx',
      filepath: '/uploads/offer.xlsx',
    };
    const result = collectSessionContext([
      message({
        files: [file],
        manualSkills: ['spreadsheets'],
        alwaysAppliedSkills: ['documents'],
      }),
      message({
        messageId: 'two',
        files: [{ file_id: file.file_id }],
        manualSkills: ['spreadsheets'],
        content: [
          {
            type: ContentTypes.STEER,
            steer: 'use this',
            files: [{ file_id: 'second', filename: 'notes.txt' }],
          },
        ],
      }),
    ]);
    expect(result.files.map((entry) => entry.file_id)).toEqual(['one-file', 'second']);
    expect(result.files[0].filename).toBe('offer.xlsx');
    expect(result.skills).toEqual(['spreadsheets', 'documents']);
    expect(result.messageIds).toEqual(['one', 'two']);
  });

  test('includes skills invoked by the model while their arguments are streaming', () => {
    const result = collectSessionContext([
      message({
        content: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              type: ToolCallTypes.TOOL_CALL,
              name: 'skill',
              args: '{"skillName":"documents',
            },
          },
        ],
      }),
    ]);
    expect(result.skills).toEqual(['documents']);
    expect(result.tools).toEqual(['skill']);
  });

  test('keeps session references readable when an indexed question tool arrives before another content part', () => {
    const queryClient = new QueryClient();
    const queryKey = ['messages', 'qa-interrupted-question'];
    const uploaded = message({
      files: [{ file_id: 'qa-file', filename: 'qa-facts.txt' }],
    });
    queryClient.setQueryData(queryKey, [uploaded]);
    const observer = new QueryObserver(queryClient, {
      queryKey,
      enabled: false,
      select: collectSessionContext,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      // useContentHandler assigns by stream index. Until the preceding part arrives,
      // for-of visits an undefined slot; final persistence later removes these gaps.
      const content: NonNullable<TMessage['content']> = [];
      content[1] = {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: 'qa-question',
          type: ToolCallTypes.TOOL_CALL,
          name: 'ask_user_question',
          args: '{"question":"Excel oder Word?","options":[{"label":"Excel","value":"Excel"}]}',
        },
      };
      queryClient.setQueryData(queryKey, [
        uploaded,
        message({ messageId: 'answer', isCreatedByUser: false, content }),
      ]);
      const result = observer.getCurrentResult();
      expect(result.isError).toBe(false);
      expect(result.data?.files.map((file) => file.file_id)).toEqual(['qa-file']);
      expect(result.data?.tools).toEqual(['ask_user_question']);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  test('lists actual function calls and retains no state when the conversation changes', () => {
    const result = collectSessionContext([
      message({
        content: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'call-1',
              type: 'function',
              function: { name: 'web_search', arguments: '{}', output: null },
            },
          },
        ],
      }),
    ]);
    expect(result.tools).toEqual(['web_search']);
    expect(collectSessionContext([])).toEqual({
      files: [],
      fileOrigins: {},
      sources: [],
      tools: [],
      skills: [],
      messageIds: [],
    });
  });

  test('separates shared references, actual tool files, and verified search metadata', () => {
    const result = collectSessionContext([
      message({ files: [{ file_id: 'input', filename: 'input.docx' }] }),
      message({
        isCreatedByUser: false,
        attachments: [
          {
            file_id: 'output',
            filename: 'output.xlsx',
            filepath: '/files/output',
            source: FileSources.local,
            user: 'owner',
            conversationId: 'current',
            messageId: 'two',
            toolCallId: 'tool',
          },
          {
            conversationId: 'current',
            messageId: 'two',
            toolCallId: 'search',
            web_search: {
              organic: [
                {
                  title: 'Documentation',
                  link: 'https://example.org/docs',
                  position: 1,
                  processed: true,
                },
                { title: 'Unsafe', link: 'javascript:alert(1)', position: 2 },
              ],
            },
          },
        ],
      }),
    ]);
    expect(result.fileOrigins.input).toEqual({ shared: true, toolOutput: false });
    expect(result.fileOrigins.output).toEqual({ shared: false, toolOutput: true });
    expect(result.files.find((file) => file.file_id === 'output')).toMatchObject({
      source: 'local',
      user: 'owner',
    });
    expect(result.sources).toEqual([
      { url: 'https://example.org/docs', title: 'Documentation', processed: true },
    ]);
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,test',
    '//outside.example/file',
    '/\\outside.example/file',
    '/\n/outside.example/file',
  ])('rejects unsafe download target %s', (target) => {
    expect(safeSessionFileUrl(target)).toBeUndefined();
  });

  test.each([
    '/uploads/report.xlsx',
    '/uploads/annual report.xlsx',
    'https://files.example/report.xlsx',
  ])('accepts a file reference %s', (target) => {
    expect(safeSessionFileUrl(target)).toBe(target);
  });
});
