import { render, screen, fireEvent } from '@testing-library/react';
import { RecoilRoot, useRecoilState } from 'recoil';
import { sessionContextHidden, useSessionVisibility } from './state';
import store from '~/store';

function Harness() {
  const { contextVisible, toggleContext } = useSessionVisibility();
  const [id, setId] = useRecoilState(store.currentArtifactId);
  const [preview, setPreview] = useRecoilState(store.artifactsVisibility);
  return (
    <>
      <button onClick={toggleContext}>Toggle</button>
      <button
        onClick={() => {
          setId(null);
          setPreview(false);
        }}
      >
        Close file
      </button>
      <output>{JSON.stringify({ contextVisible, id, preview })}</output>
    </>
  );
}
function setup() {
  render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(sessionContextHidden, false);
        set(store.currentArtifactId, 'selected-spreadsheet');
        set(store.artifactsVisibility, true);
      }}
    >
      <Harness />
    </RecoilRoot>,
  );
}
test('hiding and reopening preserves the same selected file', () => {
  setup();
  fireEvent.click(screen.getByText('Toggle'));
  expect(screen.getByRole('status')).toHaveTextContent(
    '"contextVisible":false,"id":"selected-spreadsheet","preview":false',
  );
  fireEvent.click(screen.getByText('Toggle'));
  expect(screen.getByRole('status')).toHaveTextContent(
    '"contextVisible":true,"id":"selected-spreadsheet","preview":true',
  );
});
test('closing a file returns to context and does not reopen a stale selection', () => {
  setup();
  fireEvent.click(screen.getByText('Close file'));
  fireEvent.click(screen.getByText('Toggle'));
  fireEvent.click(screen.getByText('Toggle'));
  expect(screen.getByRole('status')).toHaveTextContent(
    '"contextVisible":true,"id":null,"preview":false',
  );
});
