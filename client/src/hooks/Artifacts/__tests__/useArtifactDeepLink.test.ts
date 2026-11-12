import { renderHook } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import useArtifactDeepLink from '../useArtifactDeepLink';
jest.mock('react-router-dom', () => ({ useLocation: jest.fn() }));
jest.mock('recoil', () => ({ useRecoilValue: jest.fn(), useSetRecoilState: jest.fn() }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    artifactsState: { key: 'items' },
    currentArtifactId: { key: 'selected' },
    artifactsVisibility: { key: 'visible' },
  },
}));
const select = jest.fn(),
  show = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  (useLocation as jest.Mock).mockReturnValue({ hash: '#artifact=authorized-id' });
  (useRecoilValue as jest.Mock).mockReturnValue({});
  (useSetRecoilState as jest.Mock).mockImplementation((atom) =>
    atom.key === 'selected' ? select : show,
  );
});
it('waits for an authorized artifact and opens it once after hydration', () => {
  const { rerender } = renderHook(() => useArtifactDeepLink());
  expect(select).not.toHaveBeenCalled();
  (useRecoilValue as jest.Mock).mockReturnValue({ 'authorized-id': { content: 'Owned' } });
  rerender();
  expect(select).toHaveBeenCalledWith('authorized-id');
  expect(show).toHaveBeenCalledWith(true);
  rerender();
  expect(select).toHaveBeenCalledTimes(1);
});
it('does not invent or fetch artifacts absent from the authorized conversation', () => {
  (useRecoilValue as jest.Mock).mockReturnValue({ 'other-id': { content: 'Other' } });
  renderHook(() => useArtifactDeepLink());
  expect(select).not.toHaveBeenCalled();
  expect(show).not.toHaveBeenCalled();
});
