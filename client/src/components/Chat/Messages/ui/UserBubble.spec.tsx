import { render, screen, fireEvent } from '@testing-library/react';
import UserBubble from './UserBubble';
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
test('long prompts can be expanded and collapsed without losing their contents', () => {
  const spy = jest.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(700);
  render(
    <UserBubble active>
      <p>Long prompt</p>
    </UserBubble>,
  );
  const button = screen.getByRole('button', { name: 'com_ui_show_more' });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(button);
  expect(screen.getByRole('button', { name: 'com_ui_show_less' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('Long prompt')).toBeInTheDocument();
  expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  spy.mockRestore();
});
test('assistant and editing content stays uncollapsed', () => {
  render(<UserBubble active={false}>Response</UserBubble>);
  expect(screen.queryByRole('button')).toBeNull();
  expect(document.querySelector('.user-message-bubble')).toBeNull();
});
