import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { EToolResources as mockR } from 'librechat-data-provider';
const mockRoute = jest.fn(),
  mockClose = jest.fn();
let mockFiles: File[] = [];
jest.mock('recoil', () => ({ useRecoilValue: () => ({}) }));
jest.mock('~/store', () => ({ ephemeralAgentByConvoId: () => ({}) }));
jest.mock('@librechat/client', () => ({
  OGDialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  OGDialogTemplate: ({ title, main }: { title: string; main: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {main}
    </div>
  ),
}));
jest.mock('~/Providers', () => ({
  useUploadModalContext: () => ({ isVisible: true, files: mockFiles, closeModal: mockClose }),
  useDragDropContext: () => ({ conversationId: 'new', provider: 'openAI' }),
}));
let mockStartup = {};
let mockOptions: (mockR | undefined)[] = [];
jest.mock('~/data-provider', () => ({ useGetStartupConfig: () => ({ data: mockStartup }) }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useUploadOptions: () => ({
    getOptions: () => mockOptions,
  }),
  useFileUploadRouter: () => mockRoute,
  useAgentToolPermissions: () => ({ provider: 'openAI' }),
}));
import DragDropModal from './DragDropModal';
beforeEach(() => {
  jest.clearAllMocks();
  mockStartup = {};
  mockOptions = [mockR.file_search, mockR.execute_code, mockR.context];
  mockFiles = [
    new File(['Original'], 'Vorlage.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  ];
});
it('offers one normal upload action and keeps technical choices collapsed', () => {
  const { container } = render(<DragDropModal />);
  expect(screen.getByText('com_ui_upload_use_in_chat')).toBeInTheDocument();
  const details = container.querySelector('details')!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText('com_ui_upload_advanced'));
  expect(details.open).toBe(true);
});
it('routes Word to the permitted analysis path and closes the modal', () => {
  render(<DragDropModal />);
  fireEvent.click(screen.getByRole('button', { name: /com_ui_upload_use_in_chat/ }));
  expect(mockRoute).toHaveBeenCalledWith(mockFiles, mockR.execute_code);
  expect(mockClose).toHaveBeenCalledTimes(1);
});
it('offers the unmasked original for PDF only where the operator enabled it', () => {
  mockFiles = [new File(['%PDF-'], 'Lieferschein.pdf', { type: 'application/pdf' })];
  mockOptions = [undefined, mockR.context];
  const { unmount } = render(<DragDropModal />);
  expect(screen.queryByText('com_ui_upload_original')).not.toBeInTheDocument();
  unmount();
  mockStartup = { originalUploadEnabled: true };
  render(<DragDropModal />);
  fireEvent.click(screen.getByText('com_ui_upload_original'));
  expect(mockRoute).toHaveBeenCalledWith(mockFiles, undefined, true);
  expect(mockClose).toHaveBeenCalledTimes(1);
});
it('does not offer the original for other file types', () => {
  mockStartup = { originalUploadEnabled: true };
  mockOptions = [undefined, mockR.context];
  render(<DragDropModal />);
  expect(screen.queryByText('com_ui_upload_original')).not.toBeInTheDocument();
});
