import {
  sanitizeSignatureHtml,
  signatureFontSize,
  signatureLogoSelector,
  signatureLogoWidth,
  setSignatureLogoWidth,
  formatSignatureSelection,
  placeSignatureLogo,
  restoreSignatureRange,
} from '../formatting';

function editable(html: string) {
  const element = document.createElement('div');
  element.contentEditable = 'true';
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

test.each([
  ['8pt', '8pt'],
  ['9pt', '9pt'],
  ['12PT', '12pt'],
  ['16px', '12pt'],
  ['14.666667px', '11pt'],
  ['10.666667px', '8pt'],
  ['21.333333px', '16pt'],
  ['7pt', undefined],
  ['17pt', undefined],
  ['24px', undefined],
  ['1em', undefined],
  ['calc(8pt + 1pt)', undefined],
  ['11pt!important', undefined],
  ['var(--size)', undefined],
])('normalizes only bounded absolute font sizes: %s', (input, result) => {
  expect(signatureFontSize(input)).toBe(result);
});

test('preserves mixed Outlook text sizes and safe formatting while normalizing compact paragraphs', () => {
  const editor = editable(
    sanitizeSignatureHtml(
      '<p><span style="font-size:16px;color:rgb(12, 34, 56);font-family:\'Calibri\',Arial;font-weight:bold">Name</span></p><div><span style="font-size:10.666667px;font-style:italic;line-height:1.2">Role</span></div><p style="margin:0 0 4pt 0;font-size:14pt">Company</p>',
    ),
  );
  expect(editor.querySelector('p')).toHaveStyle({ margin: '0px' });
  expect(editor.querySelector('span')).toHaveStyle({
    fontSize: '12pt',
    color: '#0c2238',
    fontWeight: 'bold',
    fontFamily: 'Calibri,Arial',
  });
  expect(editor.querySelectorAll('span')[1]).toHaveStyle({
    fontSize: '8pt',
    fontStyle: 'italic',
    lineHeight: '1.2',
  });
  expect(editor.querySelectorAll('p')[1]).toHaveStyle({ margin: '0 0 4pt 0', fontSize: '14pt' });
});

test('removes active content and all CSS resource paths before inserting pasted markup', () => {
  const safe = sanitizeSignatureHtml(
    '<style>@import url(https://tracker.test)</style><img src="https://tracker.test"><svg onload="alert(1)"><a href="https://tracker.test">x</a></svg><p onclick="alert(1)" style="constructor:bad;__proto__:bad;toString:bad;background:url(https://tracker.test);background-image:url(https://tracker.test);font-family:url(https://tracker.test);color:var(--color);font-size:12pt!important;position:fixed;--x:url(https://tracker.test)">Safe</p><a href="javascript:alert(1)">Link</a><iframe src="https://tracker.test"></iframe>',
  );
  expect(safe).toBe('<p style="margin:0">Safe</p><a>Link</a>');
  expect(sanitizeSignatureHtml('<span style="font-size:12pt;co\\6cor:red">Safe</span>')).toBe(
    '<span>Safe</span>',
  );
  expect(sanitizeSignatureHtml('<a href="https://user:pass@example.test">x</a>')).toBe('<a>x</a>');
});

test('keeps one canonical stored logo marker but never accepts one from clipboard HTML', () => {
  const marker = '<span data-kisuno-signature-logo="true">[Signatur-Logo]</span>';
  expect(
    sanitizeSignatureHtml(
      '<span data-kisuno-signature-logo="true" style="font-size:16pt"><b>Fake</b></span><span data-kisuno-signature-logo="true">Duplicate</span>',
    ),
  ).toBe(marker);
  expect(sanitizeSignatureHtml(marker, false)).toBe('<span>[Signatur-Logo]</span>');
  expect(sanitizeSignatureHtml('<div data-kisuno-signature-logo="true">x</div>')).not.toContain(
    'data-kisuno',
  );
});

test('formats just the selected substring and preserves the selected text and surrounding styles', () => {
  const editor = editable(
    '<p><span style="color:navy;font-size:12pt">Name Role Company</span></p>',
  );
  const text = editor.querySelector('span')!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 5);
  range.setEnd(text, 9);
  const formatted = formatSignatureSelection(editor, range, 8)!;
  expect(editor.textContent).toBe('Name Role Company');
  expect(formatted.toString()).toBe('Role');
  expect(editor.querySelector('span span')).toHaveStyle({ fontSize: '8pt' });
  expect(editor.querySelector('span')).toHaveStyle({ fontSize: '12pt', color: 'rgb(0, 0, 128)' });
  expect(restoreSignatureRange(editor, formatted)).toBe(true);
  expect(window.getSelection()?.toString()).toBe('Role');
  formatSignatureSelection(editor, formatted, 10);
  expect(editor.querySelectorAll('span')).toHaveLength(2);
  expect(editor.querySelector('span span')).toHaveStyle({ fontSize: '10pt' });
});

test('preserves table and paragraph boundaries when selecting across multiple lines', () => {
  const editor = editable(
    '<table><tbody><tr><td><p>Name</p></td><td><p>Role</p></td></tr></tbody></table>',
  );
  const paragraphs = editor.querySelectorAll('p');
  const range = document.createRange();
  range.setStart(paragraphs[0].firstChild!, 0);
  range.setEnd(paragraphs[1].firstChild!, 4);
  const formatted = formatSignatureSelection(editor, range, 9)!;
  expect(formatted.toString()).toBe('NameRole');
  expect(editor.querySelectorAll('td p span')).toHaveLength(2);
  expect(editor.querySelector('td p span')).toHaveStyle({ fontSize: '9pt' });
});

test('rejects selections across the editor boundary and disconnected saved ranges', () => {
  const editor = editable('<p>Signature</p>');
  const elsewhere = editable('Other text');
  const range = document.createRange();
  range.setStart(editor.querySelector('p')!.firstChild!, 0);
  range.setEnd(elsewhere.firstChild!, 4);
  expect(formatSignatureSelection(editor, range, 8)).toBeUndefined();
  expect(placeSignatureLogo(editor, range)).toBeUndefined();
  expect(restoreSignatureRange(editor, range)).toBe(false);
  range.selectNodeContents(editor);
  editor.remove();
  expect(restoreSignatureRange(editor, range)).toBe(false);
});

test('inserts the logo after the selected role, before company, and moves the single marker', () => {
  const editor = editable('<p>Name<br>Head of Sec Ops<br>Company</p>');
  const paragraph = editor.querySelector('p')!;
  const role = paragraph.childNodes[2];
  const range = document.createRange();
  range.setStart(role, 0);
  range.setEnd(role, role.textContent!.length);
  const placed = placeSignatureLogo(editor, range)!;
  expect(editor.textContent).toBe('NameHead of Sec Ops[Signatur-Logo]Company');
  expect(editor.querySelectorAll(signatureLogoSelector)).toHaveLength(1);
  expect(placed.collapsed).toBe(true);
  range.setStart(paragraph.firstChild!, 4);
  range.collapse(true);
  placeSignatureLogo(editor, range);
  expect(editor.textContent).toBe('Name[Signatur-Logo]Head of Sec OpsCompany');
  expect(editor.querySelectorAll(signatureLogoSelector)).toHaveLength(1);
  expect(editor.querySelector('p > span')).toHaveAttribute('data-kisuno-signature-logo', 'true');
});

test('stores a bounded width only on the canonical logo marker and removes it from clipboard data', () => {
  const html =
    '<p>Role</p><span data-kisuno-signature-logo="true" data-kisuno-signature-width="120">Logo</span><p>Company</p>';
  const safe = sanitizeSignatureHtml(html);
  expect(safe).toContain(
    '<span data-kisuno-signature-logo="true" data-kisuno-signature-width="120">[Signatur-Logo]</span>',
  );
  expect(signatureLogoWidth(safe)).toBe(120);
  expect(sanitizeSignatureHtml(html, false)).not.toContain('data-kisuno');
  expect(
    sanitizeSignatureHtml('<span data-kisuno-signature-width="120">Text</span>'),
  ).not.toContain('data-kisuno');
  for (const invalid of ['79', '321', '120px', '120.5', 'url(https://tracker.test)']) {
    const dirty = `<span data-kisuno-signature-logo="true" data-kisuno-signature-width="${invalid}">Logo</span>`;
    expect(sanitizeSignatureHtml(dirty)).not.toContain('data-kisuno-signature-width');
    expect(signatureLogoWidth(dirty)).toBe(160);
  }
});

test('keeps the width while moving the logo and creates a legacy end marker when changing its width', () => {
  const editor = editable('<p>Name</p><p>Role</p><p>Company</p>');
  expect(setSignatureLogoWidth(editor, 120)).toBe(true);
  const marker = editor.querySelector(signatureLogoSelector)!;
  expect(editor.lastChild).toBe(marker);
  expect(marker).toHaveAttribute('data-kisuno-signature-width', '120');
  const role = editor.querySelectorAll('p')[1].firstChild!;
  const range = document.createRange();
  range.setStart(role, 4);
  range.collapse(true);
  placeSignatureLogo(editor, range);
  expect(editor.textContent).toBe('NameRole[Signatur-Logo]Company');
  expect(editor.querySelectorAll(signatureLogoSelector)).toHaveLength(1);
  expect(editor.querySelector(signatureLogoSelector)).toHaveAttribute(
    'data-kisuno-signature-width',
    '120',
  );
  expect(setSignatureLogoWidth(editor, 321)).toBe(false);
  expect(signatureLogoWidth(editor.innerHTML)).toBe(120);
});
