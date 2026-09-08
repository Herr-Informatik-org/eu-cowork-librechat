import { render, screen, fireEvent, act } from '@testing-library/react';
import { RecoilRoot, useRecoilState } from 'recoil';
import {
  sessionContextHidden,
  useSessionVisibility,
  useSessionExit,
  sessionClosing,
} from './state';
import store from '~/store';

jest.mock('react-router-dom', () => ({ useParams: () => ({ conversationId: 'chat-a' }) }));
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function Harness() {
  useSessionExit();
  const { contextVisible, toggleContext } = useSessionVisibility();
  const [, setClosing] = useRecoilState(sessionClosing);
  const [id] = useRecoilState(store.currentArtifactId);
  const [preview] = useRecoilState(store.artifactsVisibility);
  return (
    <>
      <button onClick={toggleContext}>Toggle</button>
      <button
        onClick={() => {
          setClosing('close');
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
  act(() => jest.advanceTimersByTime(250));
  expect(screen.getByRole('status')).toHaveTextContent(
    '"contextVisible":false,"id":"selected-spreadsheet","preview":false',
  );
  fireEvent.click(screen.getByText('Toggle'));
  act(() => jest.advanceTimersByTime(250));
  expect(screen.getByRole('status')).toHaveTextContent(
    '"contextVisible":true,"id":"selected-spreadsheet","preview":true',
  );
});
test('closing a file returns to context and does not reopen a stale selection', () => {
  setup();
  fireEvent.click(screen.getByText('Close file'));
  expect(screen.getByRole('status')).toHaveTextContent(
    '\"id\":\"selected-spreadsheet\",\"preview\":true',
  );
  act(() => jest.advanceTimersByTime(250));
  fireEvent.click(screen.getByText('Toggle'));
  fireEvent.click(screen.getByText('Toggle'));
  act(() => jest.advanceTimersByTime(250));
  expect(screen.getByRole('status')).toHaveTextContent(
    '"contextVisible":true,"id":null,"preview":false',
  );
});

test('a rapid reopen cancels exit without discarding the file', () => {
  setup();
  fireEvent.click(screen.getByText('Toggle'));
  expect(screen.getByRole('status')).toHaveTextContent('"preview":true');
  fireEvent.click(screen.getByText('Toggle'));
  act(() => jest.advanceTimersByTime(500));
  expect(screen.getByRole('status')).toHaveTextContent(
    '"contextVisible":true,"id":"selected-spreadsheet","preview":true',
  );
});
