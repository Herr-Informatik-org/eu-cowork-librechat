import { fireEvent, render, screen } from '@testing-library/react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import OfficeFilePreviewButton, { createOfficeFileArtifact } from './OfficeFilePreviewButton';
import store from '~/store';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

function StateObserver() {
  const artifacts = useRecoilValue(store.artifactsState);
  const selected = useRecoilValue(store.currentArtifactId);
  const visible = useRecoilValue(store.artifactsVisibility);
  return <output data-testid="state">{JSON.stringify({ artifacts, selected, visible })}</output>;
}

describe('Session Office upload preview', () => {
  it('opens a lazy preview for an uploaded document without an existing artifact', () => {
    const file = {
      file_id: 'uploaded-word',
      filename: 'Brief.docx',
      filepath: '/uploads/Brief.docx',
      user: 'user-1',
    };
    render(
      <RecoilRoot>
        <OfficeFilePreviewButton file={file} />
        <StateObserver />
      </RecoilRoot>,
    );
    const before = JSON.parse(screen.getByTestId('state').textContent!);
    expect(Object.keys(before.artifacts ?? {})).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_session_preview' }));
    const state = JSON.parse(screen.getByTestId('state').textContent!);
    expect(state.selected).toBe('office-file-uploaded-word');
    expect(state.visible).toBe(true);
    expect(state.artifacts[state.selected].download).toMatchObject({
      file_id: 'uploaded-word',
      filepath: '/uploads/Brief.docx',
    });
    expect(state.artifacts[state.selected].content).toContain('librechat-office-source');
    expect(file).toEqual({
      file_id: 'uploaded-word',
      filename: 'Brief.docx',
      filepath: '/uploads/Brief.docx',
      user: 'user-1',
    });
  });
  it('reuses a registered tool artifact instead of creating another file reference', () => {
    render(
      <RecoilRoot>
        <OfficeFilePreviewButton
          file={{ file_id: 'generated', filename: 'Tabelle.xlsx' }}
          artifactId="tool-artifact-generated"
        />
        <StateObserver />
      </RecoilRoot>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_session_preview' }));
    const state = JSON.parse(screen.getByTestId('state').textContent!);
    expect(state.selected).toBe('tool-artifact-generated');
    expect(Object.keys(state.artifacts ?? {})).toHaveLength(0);
  });
  it('limits lazy preview to server-backed Office files', () => {
    expect(createOfficeFileArtifact({ file_id: 'text', filename: 'instructions.txt' })).toBeNull();
    expect(createOfficeFileArtifact({ filename: 'no-id.docx' })).toBeNull();
    for (const extension of ['docx', 'pptx', 'xlsx', 'xls', 'ods']) {
      expect(
        createOfficeFileArtifact({ file_id: 'original', filename: `file.${extension}` })?.download
          ?.file_id,
      ).toBe('original');
    }
  });
});
