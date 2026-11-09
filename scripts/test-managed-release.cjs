const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot(managed) {
  const html = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1]
    .replaceAll('%VITE_KISUNO_RELEASE_MANAGED%', managed ? 'true' : 'false');
  const listeners = {};
  let reloads = 0;
  const values = new Map();
  const window = { location: { reload: () => reloads++ }, addEventListener: (key, fn) => { listeners[key] = fn; } };
  const context = { window, navigator: {}, document: { visibilityState: 'visible' },
    sessionStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    performance: { now: () => 1 }, URL, Date, JSON, Object, Array, Number };
  vm.runInNewContext(script, context);
  return { window, listeners, reloads: () => reloads };
}

test('managed build never reloads active work on failed lazy chunks or scripts', () => {
  const app = boot(true);
  assert.equal(app.window.__lcRecoverStaleAssets(), false);
  app.listeners.unhandledrejection({ reason: new Error('Failed to fetch dynamically imported module') });
  app.listeners.error({ target: { tagName: 'SCRIPT', src: '/assets/old.js', getAttribute: () => null } });
  assert.equal(app.reloads(), 0);
});

test('normal build keeps existing guarded recovery', () => {
  const app = boot(false);
  assert.equal(app.window.__lcRecoverStaleAssets(), true);
  assert.equal(app.window.__lcRecoverStaleAssets(), false);
  assert.equal(app.reloads(), 1);
});
