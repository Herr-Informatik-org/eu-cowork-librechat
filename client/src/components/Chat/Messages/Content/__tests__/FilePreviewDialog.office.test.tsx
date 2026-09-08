import { render } from '@testing-library/react';
import FilePreviewDialog from '../FilePreviewDialog';

const mockDownload = jest.fn();
const mockSetState = jest.fn();
let mockShareId: string | undefined;
jest.mock('recoil', () => ({ useRecoilValue: () => ({ id: 'user' }), useSetRecoilState: () => mockSetState }));
jest.mock('~/store', () => ({ __esModule: true, default: {} }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/Providers', () => ({ useShareContext: () => ({ shareId: mockShareId }) }));
jest.mock('~/data-provider', () => ({ useFileDownload: () => ({ refetch: mockDownload }), useSharedFileDownload: () => ({ refetch: mockDownload }) }));
jest.mock('~/utils', () => ({ logger: { error: jest.fn() }, sortPagesByRelevance: jest.fn(), triggerDownload: jest.fn() }));
jest.mock('~/components/Messages/Content/CopyButton', () => () => null);
jest.mock('@librechat/client', () => ({ OGDialog: () => null, OGDialogContent: () => null, OGDialogTitle: () => null, OGDialogDescription: () => null }));

beforeEach(() => { jest.clearAllMocks(); mockShareId = undefined; });

test('opens an uploaded XLSX in the private document viewer without reading ZIP bytes as text', () => {
  const close = jest.fn();
  render(<FilePreviewDialog open onOpenChange={close} fileId="file" fileName="Original.xlsx" fileType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />);
  expect(mockSetState).toHaveBeenCalledWith('office-file-file');
  expect(close).toHaveBeenCalledWith(false);
  expect(mockDownload).not.toHaveBeenCalled();
});

test('does not send a shared Office file to the private viewer or classify OpenXML as text', () => {
  mockShareId = 'shared';
  render(<FilePreviewDialog open onOpenChange={jest.fn()} fileId="file" fileName="Original.xlsx" fileType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />);
  expect(mockSetState).not.toHaveBeenCalled();
  expect(mockDownload).not.toHaveBeenCalled();
});
