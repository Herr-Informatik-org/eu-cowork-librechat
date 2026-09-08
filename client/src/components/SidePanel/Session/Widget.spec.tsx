import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RecoilRoot } from 'recoil';
import Widget from './Widget';
import { sessionContextHidden } from './state';
import store from '~/store';

jest.mock('./Panel', () => ({
  __esModule: true,
  default: () => <aside data-testid="context-card" />,
}));

function setup({ panel = false, artifact = '', visible = false, id = 'existing' } = {}) {
  return render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(sessionContextHidden, panel);
        set(store.currentArtifactId, artifact || null);
        set(store.artifactsVisibility, visible);
      }}
    >
      <MemoryRouter initialEntries={[`/c/${id}`]}>
        <Routes>
          <Route path="/c/:conversationId" element={<Widget />} />
        </Routes>
      </MemoryRouter>
    </RecoilRoot>,
  );
}

test('existing chats show the separate context card when no right panel is open', () => {
  setup();
  expect(screen.getByTestId('context-card')).toBeInTheDocument();
});
test('hiding the context removes the context card', () => {
  setup({ panel: true });
  expect(screen.queryByTestId('context-card')).not.toBeInTheDocument();
});
test('opening an artifact preview replaces the context card', () => {
  setup({ artifact: 'document', visible: true });
  expect(screen.queryByTestId('context-card')).not.toBeInTheDocument();
});
test('new chats do not display an empty context card', () => {
  setup({ id: 'new' });
  expect(screen.queryByTestId('context-card')).not.toBeInTheDocument();
});
