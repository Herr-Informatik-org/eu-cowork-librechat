import { render, screen } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import Panel from './Panel';

jest.mock('react-router-dom', () => ({ useParams: () => ({ conversationId: 'existing-chat' }) }));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/Providers', () => ({
  useChatContext: () => ({ index: 0 }),
  useFileMapContext: () => ({}),
}));
jest.mock('~/data-provider', () => ({
  useGetMessagesByConvoId: () => ({
    data: {
      files: [{ file_id: 'one', filename: 'Bericht.docx' }],
      skills: ['docx'],
      tools: ['execute_code'],
      messageIds: [],
      fileOrigins: { one: { shared: true } },
      sources: [{ title: 'Hidden source' }],
    },
    isLoading: false,
    isError: false,
  }),
}));
jest.mock('./FileRow', () => ({
  __esModule: true,
  default: ({ file }: { file: { filename: string } }) => <button>{file.filename}</button>,
}));

test('the compact card contains files and recorded skills without metadata or tool inventory', () => {
  render(
    <RecoilRoot>
      <Panel variant="widget" />
    </RecoilRoot>,
  );
  expect(screen.getByRole('button', { name: 'Bericht.docx' })).toBeInTheDocument();
  expect(screen.getByText('docx')).toBeInTheDocument();
  expect(screen.queryByText('execute_code')).not.toBeInTheDocument();
  expect(screen.queryByText('Hidden source')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_session_scope')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_session_shared_file')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('heading', { name: 'com_ui_session_workspace' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'com_ui_close' })).not.toBeInTheDocument();
});

test('the right panel uses the same simple content and provides a close action', () => {
  render(
    <RecoilRoot>
      <Panel />
    </RecoilRoot>,
  );
  expect(screen.getByRole('button', { name: 'Bericht.docx' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_ui_close' })).toBeInTheDocument();
});
