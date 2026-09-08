import { fireEvent, render, screen } from '@testing-library/react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import FileRow from './FileRow';
import store from '~/store';

const mockDownload = jest.fn();
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('./SessionFileDownloadButton', () => ({
  __esModule: true,
  default: () => <button aria-label="Download" onClick={mockDownload} />,
}));
jest.mock('~/components/Chat/Messages/Content/FilePreviewDialog', () => ({
  __esModule: true,
  default: ({ fileName }: { fileName: string }) => <div role="dialog">{fileName}</div>,
}));
function Observer() {
  const selected = useRecoilValue(store.currentArtifactId);
  return <output data-testid="selected">{selected}</output>;
}
const file = {
  file_id: 'office-one',
  filename: 'Kalkulation.xlsx',
  user: 'user-one',
};

test('the filename row opens the Office preview without a separate preview button', () => {
  const { container } = render(
    <RecoilRoot>
      <FileRow file={file} />
      <Observer />
    </RecoilRoot>,
  );
  expect(container.querySelector('button button')).toBeNull();
  expect(screen.queryByText('com_ui_session_preview')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: file.filename }));
  expect(screen.getByTestId('selected')).toHaveTextContent('office-file-office-one');
});

test('the independent download action does not open a preview', () => {
  render(
    <RecoilRoot>
      <FileRow file={file} />
      <Observer />
    </RecoilRoot>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('selected')).toBeEmptyDOMElement();
});

test('a text file opens the existing authorized file preview', () => {
  render(
    <RecoilRoot>
      <FileRow file={{ ...file, filename: 'Notizen.txt' }} />
    </RecoilRoot>,
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Notizen.txt' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Notizen.txt');
});
