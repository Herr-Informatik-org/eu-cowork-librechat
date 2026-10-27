import type { MailWorkspaceChatRequest } from 'librechat-data-provider';
import { buildMailChatRequest } from '../context';

const request = (patch: Partial<MailWorkspaceChatRequest> = {}): MailWorkspaceChatRequest => ({
  revision: 'a'.repeat(64),
  message: 'Bitte kürzer formulieren.',
  history: [],
  includeCorrespondence: false,
  ...patch,
});

it('caps each history entry at 4000 and keeps only the latest 12 without mutating input', () => {
  const input = request({
    history: Array.from({ length: 15 }, (_, index) => ({
      role: 'assistant',
      content: String(index),
    })),
  });
  const bounded = buildMailChatRequest(input)!;
  expect(bounded.history.map((item) => item.content)).toEqual(
    Array.from({ length: 12 }, (_, index) => String(index + 3)),
  );
  expect(input.history).toHaveLength(15);
  const longAnswer = request({ history: [{ role: 'assistant', content: 'A'.repeat(12000) }] });
  expect(buildMailChatRequest(longAnswer)!.history[0].content).toHaveLength(4000);
  expect(longAnswer.history[0].content).toHaveLength(12000);
});

it('drops oldest history first using the serialized budget including draft and current message', () => {
  const input = request({
    message: 'M'.repeat(4000),
    draft: 'D'.repeat(12000),
    history: Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: String(index).padEnd(4000, 'x'),
    })),
  });
  const bounded = buildMailChatRequest(input)!;
  expect(bounded.history).toEqual([input.history[11]]);
  expect(bounded.message).toBe(input.message);
  expect(bounded.draft).toBe(input.draft);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(24000);
  expect(input.history).toHaveLength(12);
});

it('counts escaping in JSON and trims only transmitted draft when history removal is insufficient', () => {
  const input = request({
    draft: '\\'.repeat(12000),
    history: [{ role: 'assistant', content: 'old answer' }],
  });
  const bounded = buildMailChatRequest(input)!;
  expect(bounded.history).toEqual([]);
  expect(bounded.draft!.length).toBeLessThan(12000);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(24000);
  expect(JSON.stringify({ ...bounded, draft: `${bounded.draft}\\` }).length).toBeGreaterThan(24000);
  expect(input.draft).toHaveLength(12000);
});

it('caps current message and draft independently and preserves owner-bound metadata', () => {
  const bounded = buildMailChatRequest(
    request({ message: 'M'.repeat(4500), draft: 'D'.repeat(13000), includeCorrespondence: true }),
  )!;
  expect(bounded.message).toHaveLength(4000);
  expect(bounded.draft).toHaveLength(12000);
  expect(bounded.revision).toBe('a'.repeat(64));
  expect(bounded.includeCorrespondence).toBe(true);
});

it('rejects locally when the current question alone cannot fit the serialized budget', () => {
  const input = request({
    message: '\u0000'.repeat(4000),
    draft: 'user draft',
    history: [{ role: 'assistant', content: 'context' }],
  });
  expect(buildMailChatRequest(input)).toBeUndefined();
  expect(input.message).toHaveLength(4000);
  expect(input.draft).toBe('user draft');
});
