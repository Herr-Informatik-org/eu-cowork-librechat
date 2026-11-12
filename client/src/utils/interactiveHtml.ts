/** Use a constant HTTP loader so CSP remains binding after document replacement and navigation. */
export function interactiveHtmlDocument(content: string): string {
  if (content.length > 2 * 1024 * 1024) throw new Error('Interaktives Artefakt ist zu gross.');
  // The payload is data in the trusted wrapper, never executable wrapper markup.
  const literal = JSON.stringify(content)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const target = new URL('/api/artifacts/preview', window.location.origin);
  if (!['https:', 'http:'].includes(target.protocol))
    throw new Error('Vorschauadresse ist ungültig.');
  const endpoint = target.href;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${endpoint}; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}body{background:white}</style></head><body><iframe sandbox="allow-scripts" title="Interaktives Artefakt" referrerpolicy="no-referrer"></iframe><script>const source=${literal};const frame=document.querySelector('iframe');const ready=event=>{if(event.source!==frame.contentWindow||event.data?.type!=='kisuno-artifact-ready')return;removeEventListener('message',ready);frame.contentWindow.postMessage({type:'kisuno-artifact-preview',html:source},'*')};addEventListener('message',ready);frame.src=${JSON.stringify(endpoint)};</script></body></html>`;
}

export function artifactDeepLink(href: string, artifactId: string): string {
  const url = new URL(href);
  url.searchParams.delete('artifact');
  url.hash = new URLSearchParams({ artifact: artifactId }).toString();
  url.searchParams.set('artifactView', '1');
  return url.toString();
}
