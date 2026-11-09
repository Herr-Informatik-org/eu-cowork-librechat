import fs from 'fs';
import path from 'path';

/**
 * The inline boot script in index.html sets the theme class before React mounts, so the
 * canvas rules in style.css (`html.light` / `html.dark`) apply from the first frame.
 */
const indexHtml = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
const bootScript = (() => {
  const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const script = scripts.find((source) => source.includes("getItem('color-theme')"));
  if (!script) {
    throw new Error('theme boot script missing from index.html');
  }
  return script;
})();

const runBoot = (storedTheme: string | null, prefersDark: boolean) => {
  document.documentElement.className = '';
  document.head.innerHTML = '';
  if (storedTheme == null) {
    localStorage.removeItem('color-theme');
  } else {
    localStorage.setItem('color-theme', storedTheme);
  }
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: prefersDark && query === '(prefers-color-scheme: dark)',
    media: query,
  }));
  new Function(bootScript)();
  return {
    themeClass: document.documentElement.className,
    loadingStyle: document.head.querySelector('style')?.textContent ?? '',
  };
};

describe('index.html theme boot', () => {
  afterEach(() => {
    localStorage.removeItem('color-theme');
    document.documentElement.className = '';
  });

  it('marks the light theme on a dark OS as light', () => {
    const { themeClass, loadingStyle } = runBoot('light', true);
    expect(themeClass).toBe('light');
    expect(loadingStyle).toContain('#ffffff');
  });

  it('marks the dark theme on a light OS as dark', () => {
    const { themeClass, loadingStyle } = runBoot('dark', false);
    expect(themeClass).toBe('dark');
    expect(loadingStyle).toContain('#0d0d0d');
  });

  it.each([
    ['system', true, 'dark'],
    ['system', false, 'light'],
    [null, true, 'dark'],
    [null, false, 'light'],
  ])('follows the OS for stored theme %p (prefers dark: %p)', (stored, prefersDark, expected) => {
    expect(runBoot(stored, prefersDark).themeClass).toBe(expected);
  });

  it('falls back to the OS when storage is unavailable', () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(runBoot(null, true).themeClass).toBe('dark');
    getItem.mockRestore();
  });
});
