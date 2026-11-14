import { Provider, createStore } from 'jotai';
import { act, render, screen } from '@testing-library/react';
import { chatDebugAtom } from '~/store/chatDebug';
import WorkCost from './WorkCost';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    `${key} ${Object.values(values ?? {}).join(' / ')}`,
}));

const summary = {
  requestUsd: 1.5,
  requestReservedUsd: 7.07,
  dayUsd: 65.3,
  dayReservedUsd: 7.07,
  requestLimitUsd: 10,
  dayLimitUsd: 100,
  warning: true,
  at: 100,
};

it('hides costs, reservations and warnings until debug mode is explicitly enabled', () => {
  const store = createStore();
  store.set(chatDebugAtom, false);
  const { container } = render(
    <Provider store={store}>
      <WorkCost value={summary} />
    </Provider>,
  );
  expect(container).toBeEmptyDOMElement();
  act(() => store.set(chatDebugAtom, true));
  expect(screen.getByTestId('work-cost-status')).toHaveTextContent('65.30');
  expect(screen.getByTestId('work-cost-status')).toHaveTextContent('7.07');
  expect(screen.getByTestId('work-cost-status')).toHaveTextContent('com_ui_work_cost_warning');
  act(() => store.set(chatDebugAtom, false));
  expect(container).toBeEmptyDOMElement();
});
