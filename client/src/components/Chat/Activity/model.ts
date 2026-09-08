import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ConversationActivity } from '~/store/activity';
import { findLiveAskUserQuestion } from '~/utils/approval';

export function activityFromMessages(messages: TMessage[], responseId?: string) {
  const question = findLiveAskUserQuestion(messages);
  if (question)
    return { state: 'needs-input', stage: 'question', messageId: question.messageId } as const;
  const latest = responseId
    ? messages.find((message) => message.messageId === responseId)
    : messages[messages.length - 1];
  if (!latest || latest.isCreatedByUser)
    return { state: 'waiting', stage: 'waiting', messageId: responseId } as const;
  const messageId = latest.messageId;
  for (let i = (latest.content?.length ?? 0) - 1; i >= 0; i--) {
    const part = latest.content?.[i];
    if (!part) continue;
    if (part.type === ContentTypes.TEXT && part.text)
      return { state: 'running', stage: 'writing', messageId } as const;
    if (part.type === ContentTypes.THINK && part.think)
      return { state: 'running', stage: 'thinking', messageId } as const;
    if (part.type !== ContentTypes.TOOL_CALL || !part.tool_call) continue;
    const call = part.tool_call;
    let tool: string = call.type;
    if ('name' in call) tool = call.name;
    else if ('function' in call) tool = call.function.name;
    const hasOutput =
      ('output' in call && call.output != null && call.output !== '') ||
      ('function' in call && call.function.output != null && call.function.output !== '');
    if (!hasOutput && call.progress !== 1)
      return { state: 'running', stage: 'tool', tool, messageId } as const;
    return { state: 'running', stage: 'thinking', messageId } as const;
  }
  if (latest.text) return { state: 'running', stage: 'writing', messageId } as const;
  return { state: 'waiting', stage: 'waiting', messageId } as const;
}

export function activityLabel(activity: ConversationActivity) {
  if (activity.state === 'done') return 'com_ui_activity_done' as const;
  if (activity.state === 'needs-input') return 'com_ui_activity_needs_input' as const;
  if (activity.state === 'error') return 'com_ui_activity_error' as const;
  if (activity.state === 'stopped') return 'com_ui_activity_stopped' as const;
  if (activity.stage === 'tool') return 'com_ui_activity_tool' as const;
  if (activity.stage === 'thinking') return 'com_ui_activity_thinking' as const;
  if (activity.stage === 'writing') return 'com_ui_activity_writing' as const;
  return 'com_ui_activity_waiting' as const;
}
