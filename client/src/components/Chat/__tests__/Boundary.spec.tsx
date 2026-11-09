import React, { Component, useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import Boundary from '../Boundary';

/** Fails like a real effect that reads a field of an empty submission. */
function FailingPart({ fail }: { fail: boolean }) {
  useEffect(() => {
    if (fail) {
      throw new TypeError("Cannot read properties of undefined (reading 'messageId')");
    }
  }, [fail]);
  return <div>{'activity'}</div>;
}

class OuterBoundary extends Component<
  { onCatch: (error: Error) => void; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onCatch(error);
  }

  render() {
    return this.state.failed ? <div>{'shell replaced'}</div> : this.props.children;
  }
}

function Shell({
  fail,
  resetKeys,
  onCatch,
}: {
  fail: boolean;
  resetKeys: readonly unknown[];
  onCatch: (error: Error) => void;
}) {
  return (
    <OuterBoundary onCatch={onCatch}>
      <div>{'chat shell'}</div>
      <Boundary name="ActivityBar" resetKeys={resetKeys}>
        <FailingPart fail={fail} />
      </Boundary>
    </OuterBoundary>
  );
}

describe('Boundary', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('hides a part whose effect throws instead of letting the error replace the shell', () => {
    const onCatch = jest.fn();
    render(<Shell fail={true} resetKeys={['chat-a', true]} onCatch={onCatch} />);

    expect(screen.getByText('chat shell')).toBeInTheDocument();
    expect(screen.queryByText('activity')).not.toBeInTheDocument();
    expect(screen.queryByText('shell replaced')).not.toBeInTheDocument();
    expect(onCatch).not.toHaveBeenCalled();
  });

  it('keeps the failed part hidden while its inputs are unchanged', () => {
    const onCatch = jest.fn();
    const { rerender } = render(
      <Shell fail={true} resetKeys={['chat-a', true]} onCatch={onCatch} />,
    );

    rerender(<Shell fail={false} resetKeys={['chat-a', true]} onCatch={onCatch} />);

    expect(screen.queryByText('activity')).not.toBeInTheDocument();
    expect(screen.getByText('chat shell')).toBeInTheDocument();
  });

  it('retries the part once one of its inputs changes', () => {
    const onCatch = jest.fn();
    const { rerender } = render(
      <Shell fail={true} resetKeys={['chat-a', true]} onCatch={onCatch} />,
    );

    rerender(<Shell fail={false} resetKeys={['new', false]} onCatch={onCatch} />);

    expect(screen.getByText('activity')).toBeInTheDocument();
    expect(onCatch).not.toHaveBeenCalled();
  });

  it('renders the fallback while the part is hidden', () => {
    render(
      <Boundary name="ActivityBar" resetKeys={[]} fallback={<span>{'fallback'}</span>}>
        <FailingPart fail={true} />
      </Boundary>,
    );

    expect(screen.getByText('fallback')).toBeInTheDocument();
  });
});
