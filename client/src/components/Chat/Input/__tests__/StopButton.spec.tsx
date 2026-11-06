import { fireEvent, render, screen } from '@testing-library/react';
import StopButton from '../StopButton';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => <>{render}</>,
}));

describe('StopButton', () => {
  let now = 1_000;
  beforeEach(() => {
    now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it('ignores a click that lands right after the run started', () => {
    const stop = jest.fn();
    const setShowStopButton = jest.fn();
    render(<StopButton stop={stop} setShowStopButton={setShowStopButton} />);

    now = 1_200;
    fireEvent.click(screen.getByTestId('stop-generation-button'));
    expect(stop).not.toHaveBeenCalled();

    now = 1_600;
    fireEvent.click(screen.getByTestId('stop-generation-button'));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(setShowStopButton).toHaveBeenCalledWith(false);
  });
});
