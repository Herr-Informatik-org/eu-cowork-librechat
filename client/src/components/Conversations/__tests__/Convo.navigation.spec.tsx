import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';

const mockNavigateToConvo = jest.fn();
let mockCurrentConversationId = 'other-chat';

jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: mockCurrentConversationId }),
}));
jest.mock('recoil', () => ({ useRecoilValue: () => [] }));
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
  useMediaQuery: () => true,
}));
jest.mock('~/hooks', () => ({
  useNavigateToConvo: () => ({ navigateToConvo: mockNavigateToConvo }),
  useLocalize: () => (key: string) => key,
  useShiftKey: () => false,
}));
jest.mock('~/data-provider', () => ({
  useUpdateConversationMutation: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { allConversationsSelector: {} },
}));
jest.mock('~/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  logger: { error: jest.fn() },
}));
jest.mock('../ConversationEndpointIcon', () => () => null);
jest.mock('../ConvoOptions', () => ({ ConvoOptions: () => null }));
jest.mock('../RenameForm', () => () => null);
jest.mock(
  '../ConvoLink',
  () =>
    ({ children }: { children: React.ReactNode }) =>
      children,
);
jest.mock('~/components/Chat/Activity/ActivityStatusBadge', () => () => null);

import Convo from '../Convo';

const conversation = {
  conversationId: 'test-chat',
  title: 'QA chat',
  endpoint: 'custom',
} as TConversation;
const retainView = jest.fn();

describe('Conversation navigation callbacks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentConversationId = 'other-chat';
  });

  it('uses the current mobile close callback after a breakpoint change', () => {
    const desktopToggle = jest.fn();
    const mobileToggle = jest.fn();
    const { rerender } = render(
      <Convo conversation={conversation} retainView={retainView} toggleNav={desktopToggle} />,
    );

    rerender(
      <Convo conversation={conversation} retainView={retainView} toggleNav={mobileToggle} />,
    );
    fireEvent.click(screen.getByTestId('convo-item'));

    expect(mobileToggle).toHaveBeenCalledTimes(1);
    expect(desktopToggle).not.toHaveBeenCalled();
    expect(mockNavigateToConvo).toHaveBeenCalledWith(conversation, {
      currentConvoId: 'other-chat',
    });
  });

  it('closes the navigation when choosing the currently open conversation', () => {
    mockCurrentConversationId = 'test-chat';
    const toggleNav = jest.fn();
    render(<Convo conversation={conversation} retainView={retainView} toggleNav={toggleNav} />);

    fireEvent.click(screen.getByTestId('convo-item'));

    expect(toggleNav).toHaveBeenCalledTimes(1);
    expect(mockNavigateToConvo).not.toHaveBeenCalled();
  });
});
