import { fireEvent, render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import SendButton from '../SendButton';
import { hasReadyImageAttachments } from '~/utils/imageAttachments';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({ cn: (...classes: string[]) => classes.join(' ') }));
jest.mock('@librechat/client', () => ({
  SendIcon: () => null,
  TooltipAnchor: ({ render: button }: { render: React.ReactElement }) => button,
}));

function Harness({ image = false, disabled = false }: { image?: boolean; disabled?: boolean }) {
  const methods = useForm<{ text: string }>({ defaultValues: { text: '' } });
  return (
    <>
      <input aria-label="Message" {...methods.register('text')} />
      <SendButton control={methods.control} disabled={disabled} hasImageAttachments={image} />
    </>
  );
}

test('enables Send for an image without text and disables it when the image is removed', () => {
  const { rerender } = render(<Harness image />);
  expect(screen.getByRole('button')).toBeEnabled();
  rerender(<Harness />);
  expect(screen.getByRole('button')).toBeDisabled();
});

test('retains loading and permission blocks even when an image is attached', () => {
  render(<Harness image disabled />);
  expect(screen.getByRole('button')).toBeDisabled();
});

test('keeps empty and whitespace-only drafts blocked while allowing normal text', () => {
  render(<Harness />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } });
  expect(screen.getByRole('button')).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Screenshot prüfen' } });
  expect(screen.getByRole('button')).toBeEnabled();
});

test('requires completed images and rejects a mixed draft with unfinished uploads', () => {
  const image = { file_id: 'image', type: 'image/png', progress: 1 };
  expect(hasReadyImageAttachments([image])).toBe(true);
  expect(hasReadyImageAttachments([{ ...image, progress: 0.9 }])).toBe(false);
  expect(hasReadyImageAttachments([image, { ...image, file_id: 'second', progress: 0 }])).toBe(
    false,
  );
  expect(hasReadyImageAttachments([{ ...image, type: 'application/pdf' }])).toBe(false);
  expect(hasReadyImageAttachments([{ ...image, file_id: '' }])).toBe(false);
  expect(hasReadyImageAttachments([])).toBe(false);
});
