import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { BrainDialogProvider, useBrainDialog } from '../Dialog';

let mockUserId: string | undefined = 'user-one';
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: mockUserId ? { id: mockUserId } : undefined }),
}));
jest.mock('~/hooks/useLocalize', () => ({ __esModule: true, default: () => (key: string) => key }));
jest.mock('../Workspace', () => ({
  __esModule: true,
  default: function Workspace({ initialSelectedId }: { initialSelectedId: string }) {
    const { useState } = jest.requireActual<typeof import('react')>('react');
    const [draft, setDraft] = useState('');
    return (
      <>
        <p>{initialSelectedId}</p>
        <textarea
          aria-label="Draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </>
    );
  },
}));

function Trigger() {
  const { showBrain, triggerRef } = useBrainDialog();
  return (
    <button ref={triggerRef} onClick={() => showBrain('selected-memory')}>
      {'Explore'}
    </button>
  );
}

function ResponsiveSidebar({ mobile = false }: { mobile?: boolean }) {
  return (
    <BrainDialogProvider>
      {mobile ? (
        <section>
          <Trigger />
        </section>
      ) : (
        <aside>
          <Trigger />
        </aside>
      )}
    </BrainDialogProvider>
  );
}

beforeEach(() => {
  mockUserId = 'user-one';
});

test('keeps the open memory and draft when the responsive sidebar replaces its subtree', () => {
  const view = render(<ResponsiveSidebar />);
  fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Unsaved personal draft' } });
  view.rerender(<ResponsiveSidebar mobile />);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('selected-memory')).toBeInTheDocument();
  expect(screen.getByLabelText('Draft')).toHaveValue('Unsaved personal draft');
});

test.each(['user-two', undefined])(
  'closes the Brain and discards the draft when the account becomes %s',
  (nextUser) => {
    const view = render(<ResponsiveSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Private to user one' } });
    mockUserId = nextUser;
    view.rerender(<ResponsiveSidebar />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    expect(screen.getByLabelText('Draft')).toHaveValue('');
  },
);
