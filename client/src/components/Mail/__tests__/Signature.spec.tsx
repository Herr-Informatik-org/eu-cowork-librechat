import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MailSignature } from 'librechat-data-provider';
import mockTranslations from '~/locales/en/translation.json';
import { MailSignatureSettings } from '../Signature';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: keyof typeof mockTranslations) => mockTranslations[key] || key,
}));
const signature: MailSignature = {
  enabled: false,
  html: '<p>Eigener Name</p>',
  fontFamily: 'Aptos',
  fontSize: 11,
};

test('shows only explicit personal signature data and keeps risky saved markup out of the DOM', () => {
  const onChange = jest.fn();
  render(
    <MailSignatureSettings
      value={{
        ...signature,
        html: '<img src="https://tracker.test/pixel"><p onclick="alert(1)" style="background:url(https://tracker.test)">Eigener Name</p>',
      }}
      onChange={onChange}
    />,
  );
  const editor = screen.getByRole('textbox', { name: 'Text deiner persönlichen Signatur' });
  expect(editor.innerHTML).toBe('<p>Eigener Name</p>');
  expect(editor).toHaveStyle({ fontSize: '11pt' });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Meine Signatur bei neuen Entwürfen ergänzen'));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
});

test('sanitizes rich clipboard content before inserting it and retains text formatting', () => {
  const onChange = jest.fn();
  render(<MailSignatureSettings value={{ ...signature, html: '' }} onChange={onChange} />);
  const editor = screen.getByRole('textbox');
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.paste(editor, {
    clipboardData: {
      getData: (type: string) =>
        type === 'text/html'
          ? '<b>Mein Name</b><img src="https://tracker.test"><script>alert(1)</script>'
          : 'Mein Name',
    },
  });
  expect(editor.innerHTML).toBe('<b>Mein Name</b>');
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ html: '<b>Mein Name</b>' }));
  expect(fireEvent.drop(editor)).toBe(false);
});

test('changes font and size explicitly and does not accept an oversized paste', () => {
  const onChange = jest.fn();
  render(<MailSignatureSettings value={signature} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Schrift'), { target: { value: 'Calibri' } });
  expect(onChange).toHaveBeenLastCalledWith({ ...signature, fontFamily: 'Calibri' });
  fireEvent.change(screen.getByLabelText('Grösse'), { target: { value: '14' } });
  expect(onChange).toHaveBeenLastCalledWith({ ...signature, fontSize: 14 });
  onChange.mockClear();
  fireEvent.paste(screen.getByRole('textbox'), {
    clipboardData: { getData: () => 'x'.repeat(20001) },
  });
  expect(screen.getByRole('alert')).toHaveTextContent('zu lang');
  expect(onChange).not.toHaveBeenCalled();
});

test('defaults to Calibri 11 without inserting a signature from other mail content', () => {
  render(<MailSignatureSettings onChange={jest.fn()} />);
  expect(screen.getByLabelText('Schrift')).toHaveValue('Calibri');
  expect(screen.getByLabelText('Grösse')).toHaveValue('11');
  expect(screen.getByRole('textbox')).toHaveTextContent('');
});

test('only decodes bounded uploaded images and publishes fresh canvas pixels', async () => {
  const onChange = jest.fn();
  const drawImage = jest.fn();
  const close = jest.fn();
  const bitmap = jest.fn().mockResolvedValue({ close });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: bitmap });
  const context = jest
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const encode = jest
    .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockReturnValue('data:image/png;base64,cGl4ZWxz');
  try {
    render(<MailSignatureSettings value={signature} onChange={onChange} />);
    const data = new Uint8Array(24);
    data.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(data.buffer);
    view.setUint32(16, 640);
    view.setUint32(20, 320);
    const file = new File([data], 'logo.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => data.buffer });
    fireEvent.change(screen.getByLabelText('Eigenes Signaturlogo'), { target: { files: [file] } });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ ...signature, logo: { contentBytes: 'cGl4ZWxz' } }),
    );
    expect(bitmap).toHaveBeenCalledWith(file, { resizeWidth: 320, resizeHeight: 160 });
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(encode).toHaveBeenCalledWith('image/png');
    onChange.mockClear();
    bitmap.mockClear();
    view.setUint32(16, 100000);
    fireEvent.change(screen.getByLabelText('Eigenes Signaturlogo'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Logo konnte nicht'));
    expect(bitmap).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    context.mockRestore();
    encode.mockRestore();
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  }
});
