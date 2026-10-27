import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import '@testing-library/jest-dom/extend-expect';
import { Mail, MessagesSquare, NotebookPen } from 'lucide-react';
import { render, fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MutableSnapshot } from 'recoil';
import { ActivePanelProvider, DEFAULT_PANEL } from '~/Providers/ActivePanelContext';

const mockNewConversation = jest.fn();
const mockClearMessagesCache = jest.fn();

jest.mock('~/store', () => {
  const { atom } = jest.requireActual('recoil');
  let counter = 0;
  const switchAtom = atom({
    key: 'mock-newChatSwitchToHistory',
    default: true,
  });
  const customShortcutsAtom = atom({
    key: 'mock-customShortcuts',
    default: {},
  });
  return {
    __esModule: true,
    default: {
      conversationByIndex: () =>
        atom({ key: `mock-conversationByIndex-${counter++}`, default: null }),
      conversationIdByIndex: () =>
        atom({ key: `mock-conversationIdByIndex-${counter++}`, default: null }),
      newChatSwitchToHistory: switchAtom,
      customShortcuts: customShortcutsAtom,
    },
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNewConvo: () => ({ newConversation: mockNewConversation }),
}));

jest.mock('~/utils', () => ({
  clearMessagesCache: (...args: unknown[]) => mockClearMessagesCache(...args),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({
  CLOSE_SIDEBAR_ID: 'close-sidebar',
}));

jest.mock('~/components/SidePanel/Nav', () => ({ __esModule: true, default: () => <div /> }));

jest.mock('~/components/Nav/AccountSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="account-settings" />,
}));

import ExpandedPanel from '../ExpandedPanel';
import store from '~/store';

const createLinks = (openMail?: () => void) => [
  {
    title: 'com_ui_chat_history' as const,
    icon: MessagesSquare,
    id: DEFAULT_PANEL,
  },
  ...(openMail
    ? [{ title: 'com_ui_mail_workspace' as const, icon: Mail, id: 'mail', onClick: openMail }]
    : []),
  {
    title: 'com_ui_prompts' as const,
    icon: NotebookPen,
    id: 'prompts',
  },
];

const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function PanelHarness({
  mailAvailable,
  ...props
}: Omit<React.ComponentProps<typeof ExpandedPanel>, 'links'> & { mailAvailable: boolean }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <>
      <ExpandedPanel
        {...props}
        links={createLinks(mailAvailable ? () => navigate('/mail') : undefined)}
      />
      <output data-testid="current-route">{pathname}</output>
    </>
  );
}

function renderPanel({
  expanded = true,
  onCollapse = jest.fn(),
  onExpand = jest.fn(),
  initialPanel = DEFAULT_PANEL,
  initialPath = '/c/new',
  mailAvailable = false,
  initializeState,
}: {
  expanded?: boolean;
  onCollapse?: jest.Mock;
  onExpand?: jest.Mock;
  initialPanel?: string;
  initialPath?: string;
  mailAvailable?: boolean;
  initializeState?: (snapshot: MutableSnapshot) => void;
} = {}) {
  if (initialPanel !== DEFAULT_PANEL) {
    localStorage.setItem('side:active-panel', initialPanel);
  }

  const result = render(
    <QueryClientProvider client={createQueryClient()}>
      <RecoilRoot initializeState={initializeState}>
        <MemoryRouter initialEntries={[initialPath]}>
          <ActivePanelProvider>
            <PanelHarness
              mailAvailable={mailAvailable}
              expanded={expanded}
              onCollapse={onCollapse}
              onExpand={onExpand}
            />
          </ActivePanelProvider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );

  return { ...result, onCollapse, onExpand };
}

describe('ExpandedPanel', () => {
  beforeAll(async () => {
    const warmup = renderPanel();
    await screen.findByTestId('account-settings');
    warmup.unmount();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  describe('single column navigation', () => {
    it('keeps the current panel open when its action is selected again', () => {
      const { onCollapse } = renderPanel({ expanded: true });
      const activeButton = screen.getByRole('button', {
        name: 'com_ui_chat_history',
      });
      fireEvent.click(activeButton);
      expect(onCollapse).not.toHaveBeenCalled();
    });

    it('switches panel when clicking an inactive icon while expanded', () => {
      const { onCollapse } = renderPanel({ expanded: true });
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_nav_tools' }));
      const inactiveButton = screen.getByTestId('nav-panel-prompts');
      fireEvent.click(inactiveButton);
      expect(onCollapse).not.toHaveBeenCalled();
      expect(localStorage.getItem('side:active-panel')).toBe('prompts');
    });

    it('expands sidebar when clicking any icon while collapsed', () => {
      const { onExpand } = renderPanel({ expanded: false });
      const activeButton = screen.getByRole('button', {
        name: 'com_ui_chat_history',
      });
      fireEvent.click(activeButton);
      expect(onExpand).toHaveBeenCalledTimes(1);
    });

    it('keeps the same tools entry while collapsed and expands before showing its children', () => {
      const { onExpand, container } = renderPanel({ expanded: false });
      expect(screen.queryByTestId('nav-panel-prompts')).not.toBeInTheDocument();
      const tools = screen.getByRole('button', { name: 'com_ui_nav_tools' });
      const actions = container.querySelector('nav');
      expect(actions?.querySelectorAll('button, a')).toHaveLength(3);
      fireEvent.click(tools);
      expect(onExpand).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('side:active-panel')).not.toBe('prompts');
    });
  });

  it('places labelled actions and the selected panel in one column', () => {
    const { container } = renderPanel();
    expect(screen.getByTestId('new-chat-button')).toHaveTextContent('com_ui_new_chat');
    const column = container.querySelector('.workspace-nav');
    expect(column).toHaveClass('flex-col');
    expect(column).toContainElement(screen.getByTestId('workspace-nav-content'));
    expect(screen.queryByTestId('nav-panel-prompts')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_nav_tools' }));
    fireEvent.click(screen.getByTestId('nav-panel-prompts'));
    expect(localStorage.getItem('side:active-panel')).toBe('prompts');
    expect(screen.queryByTestId('nav-panel-prompts')).not.toBeInTheDocument();
  });

  it('only the dedicated close action collapses the expanded workspace', () => {
    const { onCollapse } = renderPanel();
    fireEvent.click(screen.getByTestId('close-sidebar-button'));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  describe('mail workspace navigation', () => {
    it('shows mail as a primary action without opening the tools menu', () => {
      renderPanel({ mailAvailable: true });
      expect(screen.getByRole('button', { name: 'com_ui_mail_workspace' })).toBeVisible();
      expect(screen.queryByTestId('nav-panel-prompts')).not.toBeInTheDocument();
      expect(screen.getByTestId('nav-panel-mail')).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByTestId('nav-panel-conversations')).toHaveAttribute('aria-pressed', 'true');
    });

    it('does not invent a mail action when the available links omit it', () => {
      renderPanel();
      expect(screen.queryByTestId('nav-panel-mail')).not.toBeInTheDocument();
    });

    it('marks only mail active on a directly opened mail route', () => {
      renderPanel({ mailAvailable: true, initialPath: '/mail', initialPanel: 'prompts' });
      expect(screen.getByTestId('nav-panel-mail')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('nav-panel-conversations')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_nav_tools' }));
      expect(screen.getByTestId('nav-panel-prompts')).toHaveAttribute('aria-pressed', 'false');
    });

    it('navigates to mail and updates the active action without changing the saved panel', () => {
      renderPanel({ mailAvailable: true, initialPanel: 'prompts' });
      fireEvent.click(screen.getByTestId('nav-panel-mail'));
      expect(screen.getByTestId('current-route')).toHaveTextContent('/mail');
      expect(screen.getByTestId('nav-panel-mail')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('nav-panel-conversations')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(localStorage.getItem('side:active-panel')).toBe('prompts');
    });
  });

  describe('NewChatButton panel switch', () => {
    it('switches to chat history panel on new chat click when setting is enabled', () => {
      renderPanel({ expanded: true, initialPanel: 'prompts' });

      const newChatLink = screen.getByTestId('new-chat-button');
      fireEvent.click(newChatLink);

      expect(mockNewConversation).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('side:active-panel')).toBe(DEFAULT_PANEL);
    });

    it('does not switch panel on new chat click when setting is disabled', () => {
      renderPanel({
        expanded: true,
        initialPanel: 'prompts',
        initializeState: ({ set }: MutableSnapshot) => {
          set(store.newChatSwitchToHistory, false);
        },
      });

      const newChatLink = screen.getByTestId('new-chat-button');
      fireEvent.click(newChatLink);

      expect(mockNewConversation).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('side:active-panel')).toBe('prompts');
    });
  });
});
