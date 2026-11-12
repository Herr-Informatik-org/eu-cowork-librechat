import { interactiveHtmlDocument, artifactDeepLink } from './interactiveHtml';
describe('isolated interactive HTML', () => {
  it('encapsulates scripts as data until the opaque inner frame loads', () => {
    const result = interactiveHtmlDocument(
      '<h1>Rechner</h1><button onclick="this.textContent=2">1</button><script>window.result=12*150</script>',
    );
    expect(result).toContain('sandbox="allow-scripts"');
    expect(result).not.toContain('allow-same-origin');
    expect(result).toContain('/api/artifacts/preview');
    expect(result).not.toContain('frame-src blob:');
    expect(result).toContain('content-security-policy');
    expect(result).toContain("credentials:'omit'");
    expect(result).not.toContain('<script>window.result=12*150</script>');
    expect(result).toContain('window.result=12*150');
  });
  it('keeps untrusted markup inert until the HTTP-isolated loader receives it', () => {
    const result = interactiveHtmlDocument('<iframe src="https://evil.invalid"></iframe>');
    expect(result).not.toContain('<iframe src="https://evil.invalid">');
    expect(result).toContain('kisuno-artifact-preview');
    expect(result).not.toContain('allow-same-origin');
  });
  it('encodes script delimiters without injecting a wrapper script', () => {
    const result = interactiveHtmlDocument(
      '<script>const x="</script><script>parent.pwned=true</script>"</script>',
      '</script><script>parent.errorInjected=true</script>',
    );
    expect((result.match(/<script>/g) || []).length).toBe(1);
    expect(result).toContain('\\u003c');
  });
  it('builds an authenticated conversation link without publishing content', () => {
    const url = new URL(
      artifactDeepLink('https://chat.example/c/private-id?x=1', 'artifact/a & b'),
    );
    expect(url.pathname).toBe('/c/private-id');
    expect(new URLSearchParams(url.hash.slice(1)).get('artifact')).toBe('artifact/a & b');
    expect(url.search).not.toContain('artifact/a');
    expect(url.searchParams.get('artifactView')).toBe('1');
    expect(url.searchParams.get('x')).toBe('1');
  });
});
