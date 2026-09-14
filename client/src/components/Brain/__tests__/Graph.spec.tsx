import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import Graph from '../Graph';
import { graphFixture } from './fixtures';

jest.mock('~/hooks/useLocalize', () => ({ __esModule: true, default: () => (key: string) => key }));

test('all visible knowledge nodes can be selected with the keyboard', () => {
  const onSelect = jest.fn();
  render(<Graph {...graphFixture} onSelect={onSelect} />);
  const node = screen.getByRole('button', { name: /Projekt Abendrot/ });
  expect(node).toHaveAttribute('tabindex', '0');
  fireEvent.keyDown(node, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith('node-one');
  fireEvent.keyDown(node, { key: ' ' });
  expect(onSelect).toHaveBeenCalledTimes(2);
});

test('an empty Brain contains no invented selectable memories', () => {
  render(<Graph nodes={[]} edges={[]} onSelect={jest.fn()} compact />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.getByRole('group')).toBeInTheDocument();
});
