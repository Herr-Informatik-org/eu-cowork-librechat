import DOMPurify from 'dompurify';

export const signatureLogoAttribute = 'data-kisuno-signature-logo';
export const signatureLogoSelector = `[${signatureLogoAttribute}="true"]`;
const logoText = '[Signatur-Logo]';
export const signatureFontSizes = [8, 9, 10, 11, 12, 14, 16] as const;

export function signatureFontSize(value: string): string | undefined {
  const match = /^(\d+(?:\.\d{1,6})?)(pt|px)$/i.exec(value.trim());
  if (!match) return;
  const points =
    Math.round(Number(match[1]) * (match[2].toLowerCase() === 'px' ? 0.75 : 1) * 100) / 100;
  if (points >= 8 && points <= 16) return `${points}pt`;
}

const spacing =
  /^(?:0|(?:[0-9]|1[0-9]|2[0-4])(?:px|pt))(?: (?:0|(?:[0-9]|1[0-9]|2[0-4])(?:px|pt))){0,3}$/;
const allowedStyles: Record<string, RegExp> = {
  color: /^(?:#[a-f0-9]{3}|#[a-f0-9]{6}|black|white|gray|grey|navy|blue|teal|green)$/i,
  'font-family': /^(?:Aptos|Calibri|Arial|sans-serif)(?:,\s*(?:Aptos|Calibri|Arial|sans-serif))*$/i,
  'font-weight': /^(?:normal|bold|[1-9]00)$/,
  'font-style': /^(?:normal|italic)$/,
  'text-decoration': /^(?:none|underline|line-through)$/,
  'text-align': /^(?:left|center|right)$/,
  'vertical-align': /^(?:top|middle|bottom)$/,
  'line-height': /^(?:normal|1(?:\.[0-9]{1,2})?|2)$/,
  margin: spacing,
  padding: spacing,
  'border-collapse': /^(?:collapse|separate)$/,
};

function signatureStyle(style: string, compactParagraph: boolean): string {
  const result = new Map<string, string>(compactParagraph ? [['margin', '0']] : []);
  // Reject CSS escapes/control bytes before interpreting individual allowlisted declarations.
  // eslint-disable-next-line no-control-regex
  if (style.length <= 2048 && !/[\\\u0000-\u001f@{}]/.test(style)) {
    for (const declaration of style.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const name = declaration.slice(0, colon).trim().toLowerCase();
      let value = declaration.slice(colon + 1).trim();
      if (name === 'font-size') {
        const normalized = signatureFontSize(value);
        if (normalized) result.set(name, normalized);
        continue;
      }
      if (name === 'font-family') value = value.replace(/['"]/g, '');
      if (name === 'color') {
        const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(value);
        if (rgb && rgb.slice(1).every((part) => Number(part) <= 255))
          value =
            '#' +
            rgb
              .slice(1)
              .map((part) => Number(part).toString(16).padStart(2, '0'))
              .join('');
      }
      if (
        Object.prototype.hasOwnProperty.call(allowedStyles, name) &&
        allowedStyles[name].test(value)
      )
        result.set(name, value);
    }
  }
  return [...result].map(([name, value]) => `${name}:${value}`).join(';');
}

/** Return inert, canonical signature markup before any clipboard content enters the live editor. */
export function sanitizeSignatureHtml(html: string, preserveLogo = true): string {
  const sanitizer = DOMPurify();
  sanitizer.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;
    const style = signatureStyle(
      node.getAttribute('style') || '',
      ['P', 'DIV'].includes(node.tagName),
    );
    if (style) node.setAttribute('style', style);
    else node.removeAttribute('style');
    for (const name of ['colspan', 'rowspan']) {
      if (!/^(?:[1-9]|1\d|20)$/.test(node.getAttribute(name) || '')) node.removeAttribute(name);
    }
    if (node.hasAttribute('href')) {
      try {
        const url = new URL(node.getAttribute('href') || '');
        if (
          !['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ||
          url.username ||
          url.password
        )
          node.removeAttribute('href');
      } catch {
        node.removeAttribute('href');
      }
    }
    if (
      !preserveLogo ||
      node.tagName !== 'SPAN' ||
      node.getAttribute(signatureLogoAttribute) !== 'true'
    )
      node.removeAttribute(signatureLogoAttribute);
  });
  const fragment = sanitizer.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      'p',
      'div',
      'span',
      'br',
      'b',
      'strong',
      'i',
      'em',
      'u',
      's',
      'a',
      'table',
      'tbody',
      'tr',
      'td',
    ],
    ALLOWED_ATTR: ['style', 'href', 'title', 'colspan', 'rowspan', signatureLogoAttribute],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: [
      'img',
      'svg',
      'math',
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'template',
      'form',
      'input',
      'link',
      'meta',
    ],
    FORBID_CONTENTS: ['svg', 'math', 'script', 'style', 'iframe', 'object', 'embed', 'template'],
  });
  const markers = fragment.querySelectorAll(signatureLogoSelector);
  markers.forEach((marker, index) => {
    if (index) {
      marker.remove();
      return;
    }
    for (const attribute of [...marker.attributes]) marker.removeAttribute(attribute.name);
    marker.setAttribute(signatureLogoAttribute, 'true');
    marker.textContent = logoText;
  });
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

export function isSignatureRange(editor: HTMLElement, range?: Range | null): range is Range {
  return !!range && editor.contains(range.startContainer) && editor.contains(range.endContainer);
}

export function restoreSignatureRange(editor: HTMLElement, range: Range): boolean {
  if (!editor.isConnected || !isSignatureRange(editor, range)) return false;
  editor.focus();
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return !!selection;
}

export function formatSignatureSelection(
  editor: HTMLElement,
  range: Range,
  size: number,
): Range | undefined {
  if (
    !isSignatureRange(editor, range) ||
    range.collapsed ||
    !signatureFontSizes.some((value) => value === size)
  )
    return;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const parts: { node: Text; start: number; end: number }[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!range.intersectsNode(node) || node.parentElement?.closest(signatureLogoSelector)) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (end > start) parts.push({ node, start, end });
  }
  const selected: Text[] = [];
  for (const { node, start, end } of parts) {
    if (end < node.length) node.splitText(end);
    const text = start ? node.splitText(start) : node;
    const parent = text.parentElement;
    if (parent?.tagName === 'SPAN' && parent.childNodes.length === 1)
      parent.style.fontSize = `${size}pt`;
    else {
      const span = document.createElement('span');
      span.style.fontSize = `${size}pt`;
      text.before(span);
      span.append(text);
    }
    selected.push(text);
  }
  if (!selected.length) return;
  const next = document.createRange();
  next.setStart(selected[0], 0);
  const last = selected[selected.length - 1];
  next.setEnd(last, last.length);
  return next;
}

export function placeSignatureLogo(editor: HTMLElement, range: Range): Range | undefined {
  if (!isSignatureRange(editor, range)) return;
  const position = range.cloneRange();
  position.collapse(false);
  editor.querySelectorAll(signatureLogoSelector).forEach((marker) => marker.remove());
  const marker = document.createElement('span');
  marker.setAttribute(signatureLogoAttribute, 'true');
  marker.textContent = logoText;
  position.insertNode(marker);
  position.setStartAfter(marker);
  position.collapse(true);
  return position;
}
