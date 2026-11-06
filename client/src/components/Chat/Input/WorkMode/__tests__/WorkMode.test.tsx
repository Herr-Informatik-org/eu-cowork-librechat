import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import {
  WorkModeSwitch,
  getWorkMode,
  setWorkMode,
  resetWorkModes,
  getSubmitWorkMode,
  adoptNewConversationMode,
} from '..';

let mockEndpointsConfig: TEndpointsConfig = undefined;

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    ({
      com_ui_work_mode: 'Arbeitsmodus',
      com_ui_work_mode_plan: 'Planen',
      com_ui_work_mode_ask: 'Fragen',
      com_ui_work_mode_auto: 'Auto',
      com_ui_work_mode_default: 'Vorgabe',
    })[key] ?? key,
}));

const withWorkModes = (defaultMode: 'plan' | 'ask' | 'auto' = 'auto') => {
  mockEndpointsConfig = {
    [EModelEndpoint.agents]: { order: 1, workModes: { default: defaultMode } },
  } as TEndpointsConfig;
};

beforeEach(() => {
  window.localStorage.clear();
  resetWorkModes();
  mockEndpointsConfig = undefined;
});

describe('work mode store', () => {
  test('remembers the mode per conversation in local storage', () => {
    setWorkMode('c1', 'plan');
    resetWorkModes();
    expect(getWorkMode('c1')).toBe('plan');
    expect(getWorkMode('c2')).toBeUndefined();
  });

  test('ignores tampered storage values', () => {
    window.localStorage.setItem('kisuno:workModes', JSON.stringify({ c1: 'bypass', c2: 'ask' }));
    expect(getWorkMode('c1')).toBeUndefined();
    expect(getWorkMode('c2')).toBe('ask');
  });

  test("a new chat's choice moves to its id after the first submit", () => {
    setWorkMode(null, 'ask');
    expect(getSubmitWorkMode(null)).toBe('ask');
    adoptNewConversationMode('real-id');
    expect(getWorkMode('real-id')).toBe('ask');
    expect(getWorkMode('new')).toBeUndefined();
  });

  test('switching from a new chat without submitting adopts nothing', () => {
    setWorkMode('new', 'plan');
    adoptNewConversationMode('other');
    expect(getWorkMode('other')).toBeUndefined();
    expect(getWorkMode('new')).toBe('plan');
  });
});

describe('WorkModeSwitch', () => {
  test('stays hidden unless the server enforces work modes', () => {
    const { container } = render(<WorkModeSwitch conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  test('shows the server default and stores a picked mode', async () => {
    withWorkModes('auto');
    render(<WorkModeSwitch conversationId="c1" endpoint="agents" />);
    const button = screen.getByRole('button', { name: 'Arbeitsmodus: Auto' });
    fireEvent.click(button);
    const plan = await screen.findByRole('menuitemradio', { name: /Planen/ });
    expect(screen.getByRole('menuitemradio', { name: /Auto/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(plan);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Arbeitsmodus: Planen' })).toBeInTheDocument(),
    );
    expect(getWorkMode('c1')).toBe('plan');
  });

  test('number keys pick a mode in the open menu', async () => {
    withWorkModes('auto');
    render(<WorkModeSwitch conversationId="c2" endpoint="agents" />);
    fireEvent.click(screen.getByRole('button', { name: 'Arbeitsmodus: Auto' }));
    const menu = await screen.findByRole('menu', { name: 'Arbeitsmodus' });
    fireEvent.keyDown(menu, { key: '2' });
    await waitFor(() => expect(getWorkMode('c2')).toBe('ask'));
  });
});
