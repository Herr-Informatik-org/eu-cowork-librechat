import React from 'react';
import { render, screen } from '@testing-library/react';
import { ArtifactPreview } from '../ArtifactPreview';
const mockProvider = jest.fn();
jest.mock('@codesandbox/sandpack-react/unstyled', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    SandpackProvider: (props: { children: React.ReactNode }) => {
      mockProvider(props);
      return <>{props.children}</>;
    },
    SandpackPreview: React.forwardRef(function Preview() {
      return <div>Freigegebene Vorschau</div>;
    }),
  };
});
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
const props = {
  files: {
    '/App.tsx': 'export default function App(){return <p>Private Beispieldaten</p>}',
  },
  fileKey: '/App.tsx',
  template: 'react-ts' as const,
  sharedProps: {},
  previewRef: { current: null! },
};
beforeEach(() => jest.clearAllMocks());
it('never mounts the external default bundler for private artifact source', () => {
  render(<ArtifactPreview {...props} />);
  expect(mockProvider).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('com_ui_artifact_internal_preview_required');
});
it('allows an explicitly configured internal bundler', () => {
  render(
    <ArtifactPreview
      {...props}
      startupConfig={{ bundlerURL: 'https://artifacts.example/internal-bundler/' }}
    />,
  );
  expect(mockProvider).toHaveBeenCalled();
  expect(screen.getByText('Freigegebene Vorschau')).toBeInTheDocument();
});

it.each(['/bundler/', 'javascript:alert(1)'])('rejects unsafe bundler configuration %s', (url) => {
  render(<ArtifactPreview {...props} startupConfig={{ bundlerURL: url }} />);
  expect(mockProvider).not.toHaveBeenCalled();
});
