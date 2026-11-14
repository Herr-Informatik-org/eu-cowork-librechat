import { Provider, createStore } from 'jotai';
import { render, screen } from '@testing-library/react';
import { ContentTypes, ErrorTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { chatDebugAtom } from '~/store/chatDebug';
import { ErrorMessage, UnfinishedMessage } from '../MessageContent';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({ cn: (...values: string[]) => values.filter(Boolean).join(' ') }));
jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const pause = JSON.stringify({
  type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED,
  status: 'incomplete',
  reason: 'section_limit',
});

it('removes the separate pause banner while retaining ordinary errors', () => {
  const store = createStore();
  store.set(chatDebugAtom, false);
  const { container, rerender } = render(
    <Provider store={store}>
      <ErrorMessage text={pause} />
    </Provider>,
  );
  expect(container).toBeEmptyDOMElement();
  rerender(
    <Provider store={store}>
      <ErrorMessage
        text={JSON.stringify({
          type: ErrorTypes.AGENT_WORK_BUDGET_EXCEEDED,
          status: 'incomplete',
          reason: 'control_unavailable',
        })}
      />
    </Provider>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('com_error_work_control_unavailable');
});

it('offers pause diagnostics in debug mode without a red alert', () => {
  const store = createStore();
  store.set(chatDebugAtom, true);
  render(
    <Provider store={store}>
      <ErrorMessage text={pause} />
    </Provider>,
  );
  expect(screen.getByText('com_ui_work_pause_debug')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not add a generic incomplete-response alert to a controlled pause', () => {
  const message: TMessage = {
    messageId: 'paused',
    conversationId: 'chat',
    parentMessageId: null,
    isCreatedByUser: false,
    text: '',
    unfinished: true,
    content: [{ type: ContentTypes.ERROR, error: pause }],
  };
  const { container } = render(<UnfinishedMessage message={message} />);
  expect(container).toBeEmptyDOMElement();
});
