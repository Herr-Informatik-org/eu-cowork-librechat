import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getFoldedStepStart } from '../fold';
import { useExclusiveDetail } from '../detail';
import { trackStepDuration, resetStepDurations } from '../duration';

function Detail({ id }: { id?: string }) {
  const [open, setOpen] = useExclusiveDetail(id, () => false);
  return (
    <button type="button" aria-expanded={open} onClick={() => setOpen((prev) => !prev)}>
      {id ?? 'local'}
    </button>
  );
}

describe('steps', () => {
  test('only one detail is open at a time', () => {
    render(
      <>
        <Detail id="a" />
        <Detail id="b" />
      </>,
    );
    const a = screen.getByRole('button', { name: 'a' });
    const b = screen.getByRole('button', { name: 'b' });
    fireEvent.click(a);
    expect(a).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(b);
    expect(a).toHaveAttribute('aria-expanded', 'false');
    expect(b).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(b);
    expect(b).toHaveAttribute('aria-expanded', 'false');
  });

  test('steps without an id keep their own state', () => {
    render(
      <>
        <Detail />
        <Detail id="c" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'local' }));
    fireEvent.click(screen.getByRole('button', { name: 'c' }));
    expect(screen.getByRole('button', { name: 'local' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('unmounting the open step releases it', () => {
    const { unmount } = render(<Detail id="d" />);
    fireEvent.click(screen.getByRole('button', { name: 'd' }));
    act(() => unmount());
    render(<Detail id="d" />);
    expect(screen.getByRole('button', { name: 'd' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('measures a step only when it was seen running', () => {
    resetStepDurations();
    let now = 1000;
    const clock = () => now;
    expect(trackStepDuration('s1', false, clock)).toBeUndefined();
    now = 1400;
    expect(trackStepDuration('s1', true, clock)).toBe(400);
    now = 9000;
    expect(trackStepDuration('s1', true, clock)).toBe(400);
    expect(trackStepDuration('s2', true, clock)).toBeUndefined();
  });

  test('a finished group keeps the last two steps visible', () => {
    expect(getFoldedStepStart([true, true])).toEqual({ start: 0, hidden: 0 });
    expect(getFoldedStepStart([true, false, true, true, false, true])).toEqual({
      start: 3,
      hidden: 2,
    });
  });
});
