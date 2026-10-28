import { useState } from 'react';
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
  expect(editor.innerHTML).toBe('<p style="margin:0">Eigener Name</p>');
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
  fireEvent.change(screen.getByLabelText('Antwortschrift'), { target: { value: 'Calibri' } });
  expect(onChange).toHaveBeenLastCalledWith({ ...signature, fontFamily: 'Calibri' });
  fireEvent.change(screen.getByLabelText('Antwortgrösse'), { target: { value: '14' } });
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
  expect(screen.getByLabelText('Antwortschrift')).toHaveValue('Calibri');
  expect(screen.getByLabelText('Antwortgrösse')).toHaveValue('11');
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

function ControlledSignature({
  initial,
  disabled = false,
}: {
  initial: MailSignature;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <MailSignatureSettings value={value} onChange={setValue} disabled={disabled} />
      <output data-testid="saved-signature">{JSON.stringify(value)}</output>
    </>
  );
}

function selectText(node: Node, start: number, end = start) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event('selectionchange'));
}

test('formats selected text independently and retains selection through controlled rerenders and toolbar focus', () => {
  render(<ControlledSignature initial={{ ...signature, html: '<p>Name</p><p>Role</p>' }} />);
  const editor = screen.getByRole('textbox');
  selectText(editor.querySelectorAll('p')[1].firstChild!, 0, 4);
  const size = screen.getByLabelText('Grösse des markierten Texts');
  expect(size).toBeEnabled();
  fireEvent.mouseDown(size);
  size.focus();
  fireEvent.change(size, { target: { value: '8' } });
  expect(editor.querySelectorAll('p')[1].querySelector('span')).toHaveStyle({ fontSize: '8pt' });
  expect(screen.getByLabelText('Antwortgrösse')).toHaveValue('11');
  expect(window.getSelection()?.toString()).toBe('Role');
  fireEvent.change(size, { target: { value: '9' } });
  expect(editor.querySelectorAll('p')[1].querySelector('span')).toHaveStyle({ fontSize: '9pt' });
  expect(window.getSelection()?.toString()).toBe('Role');
  expect(screen.getByTestId('saved-signature')).toHaveTextContent('font-size:9pt');
});

test('places and moves an existing logo at the remembered cursor without duplicating it', () => {
  render(
    <ControlledSignature
      initial={{
        ...signature,
        html: '<p>Name<br>Head of Sec Ops<br>Company</p>',
        logo: { contentBytes: 'cGl4ZWxz' },
      }}
    />,
  );
  const editor = screen.getByRole('textbox');
  const button = screen.getByRole('button', { name: 'Logo hier einfügen / verschieben' });
  expect(button).toBeDisabled();
  const role = editor.querySelector('p')!.childNodes[2];
  selectText(role, role.textContent!.length);
  fireEvent.mouseDown(button);
  fireEvent.click(button);
  expect(editor.textContent).toBe('NameHead of Sec Ops[Signatur-Logo]Company');
  expect(editor.querySelectorAll('[data-kisuno-signature-logo]')).toHaveLength(1);
  selectText(editor.querySelector('p')!.firstChild!, 4);
  fireEvent.click(button);
  expect(editor.textContent).toBe('Name[Signatur-Logo]Head of Sec OpsCompany');
  expect(editor.querySelectorAll('[data-kisuno-signature-logo]')).toHaveLength(1);
  expect(screen.getByLabelText('Logobreite')).toHaveValue('160');
  fireEvent.change(screen.getByLabelText('Logobreite'), { target: { value: '120' } });
  expect(screen.getByRole('img')).toHaveStyle({ width: 'auto', maxWidth: 'min(100%, 120px)' });
  fireEvent.click(screen.getByRole('button', { name: 'Logo entfernen' }));
  expect(editor.textContent).toBe('NameHead of Sec OpsCompany');
  expect(editor.querySelector('[data-kisuno-signature-logo]')).toBeNull();
});

test('never formats or pastes a selection that crosses into other page content', () => {
  const change = jest.fn();
  render(
    <>
      <MailSignatureSettings value={signature} onChange={change} />
      <p data-testid="outside">{'Other content'}</p>
    </>,
  );
  const editor = screen.getByRole('textbox');
  const range = document.createRange();
  range.setStart(editor.querySelector('p')!.firstChild!, 0);
  range.setEnd(screen.getByTestId('outside').firstChild!, 4);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event('selectionchange'));
  expect(screen.getByLabelText('Grösse des markierten Texts')).toBeDisabled();
  fireEvent.paste(editor, { clipboardData: { getData: () => 'Injected text' } });
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByTestId('outside')).toHaveTextContent('Other content');
  expect(editor).toHaveTextContent('Eigener Name');
});

test('disables formatting and logo placement while settings are read only', () => {
  render(
    <ControlledSignature disabled initial={{ ...signature, logo: { contentBytes: 'cGl4ZWxz' } }} />,
  );
  selectText(screen.getByRole('textbox').querySelector('p')!.firstChild!, 0, 3);
  expect(screen.getByLabelText('Grösse des markierten Texts')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Logo hier einfügen / verschieben' })).toBeDisabled();
});
