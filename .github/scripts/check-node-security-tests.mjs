import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const baselineRevision = '5b4f6ad0247cf18b42f468575075d6f7723a7ff0';
const reports = path.join(process.env.RUNNER_TEMP || tmpdir(), 'node-security-tests');
const jest = path.join(root, 'node_modules/jest/bin/jest.js');
mkdirSync(reports, { recursive: true });

function run(node, workspace, config, suffix, files = []) {
  const report = path.join(reports, `${workspace.replaceAll('/', '-')}-${suffix}.json`);
  const args = [jest, '--config', config, '--ci', '--coverage=false', '--maxWorkers=2',
    '--workerIdleMemoryLimit=1GB', '--json', '--outputFile', report];
  if (workspace === 'packages/api') {
    args.push('--testPathIgnorePatterns=\\.*integration\\.|\\.*helper\\.|__tests__/helpers/|\\.*manual\\.spec\\.');
  }
  if (workspace === 'client') {
    // This data-only helper is not a test suite; all actual Brain tests still run.
    args.push('--testPathIgnorePatterns=/node_modules/|/Brain/__tests__/fixtures\\.ts$');
  }
  if (files.length) args.push('--runTestsByPath', ...files);
  const result = spawnSync(node, args, {
    cwd: path.join(root, workspace), stdio: 'inherit',
    env: { ...process.env, NODE_ENV: workspace === 'client' ? 'development' : 'test' },
  });
  if (result.signal || result.error) throw new Error(`Test runner stopped: ${workspace} ${result.signal || result.error}`);
  const data = JSON.parse(readFileSync(report, 'utf8'));
  assert(data.numTotalTests > 0, `${workspace}: no tests executed`);
  return { code: result.status, data };
}

function clean(message) {
  return String(message || '').replace(/\u001b\[[0-9;]*m/g, '')
    .replaceAll(root, '<repo>').split('\n')
    .filter((line) => !/^\s+at /.test(line)).join('\n').trim();
}

function failures(data) {
  const result = new Map();
  for (const suite of data.testResults) {
    const failed = suite.assertionResults.filter((test) => test.status === 'failed');
    for (const test of failed) {
      result.set(`${path.relative(root, suite.name)}: ${test.fullName}`, clean(test.failureMessages.join('\n')));
    }
    if (suite.status === 'failed' && failed.length === 0) {
      result.set(path.relative(root, suite.name), clean(suite.message));
    }
  }
  return result;
}

function verifyUnchangedApplication() {
  const exists = spawnSync('git', ['cat-file', '-e', baselineRevision], { stdio: 'ignore' });
  if (exists.status !== 0) {
    const fetch = spawnSync('git', ['fetch', '--depth=1', 'origin', baselineRevision], { stdio: 'inherit' });
    assert.equal(fetch.status, 0, 'Cannot inspect the application baseline');
  }
  const result = spawnSync('git', ['diff', '--quiet', baselineRevision, '--',
    'api', 'client', 'packages', 'config', 'skill', 'package.json', 'package-lock.json']);
  assert.equal(result.status, 0, 'Application changes require a fully passing suite; baseline exceptions are restricted to this runtime-only patch');
}

let failed = false;
for (const [workspace, config] of [
  ['packages/data-provider', 'jest.config.js'],
  ['packages/data-schemas', 'jest.config.mjs'],
  ['packages/api', 'jest.config.mjs'],
  ['api', 'jest.config.js'],
  ['client', 'jest.config.cjs'],
]) {
  console.log(`::group::${workspace}`);
  try {
    const original = run(process.execPath, workspace, config, 'security');
    if (original.code === 0) continue;
    verifyUnchangedApplication();
    assert(process.env.NODE_BASELINE, 'Baseline runtime not configured');
    const files = original.data.testResults.filter((suite) => suite.status === 'failed').map((suite) => suite.name);
    assert(files.length > 0, 'Runner failed without a failed suite');
    const retry = run(process.execPath, workspace, config, 'retry', files);
    const baseline = run(process.env.NODE_BASELINE, workspace, config, 'baseline', files);
    const oldFailures = failures(baseline.data);
    const newFailures = failures(retry.data);
    assert(retry.code === 0 || newFailures.size > 0, 'Security runner failed without diagnostic results');
    assert(baseline.code === 0 || oldFailures.size > 0, 'Baseline runner failed without diagnostic results');
    for (const [name, message] of newFailures) {
      assert(oldFailures.has(name), `New failure under the security runtime: ${name}`);
      assert.equal(message, oldFailures.get(name), `Changed failure under the security runtime: ${name}`);
    }
    console.log(`::warning::${workspace}: original run had ${original.data.numFailedTests} failed tests; ${failures(retry.data).size} reproduced identically on Node 24.16.0. Application source matches ${baselineRevision}. Reports retain all original results.`);
  } catch (error) {
    console.error(error);
    failed = true;
  } finally {
    console.log('::endgroup::');
  }
}
if (failed) process.exitCode = 1;
