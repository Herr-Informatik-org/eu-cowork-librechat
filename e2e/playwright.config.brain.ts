import { defineConfig } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import base from './playwright.config.mock';

const root = path.resolve(__dirname, '..');
const port = process.env.E2E_BRAIN_PORT || '3026';
const brainEnv = {
  BRAIN_API_URL: `http://127.0.0.1:${port}`,
  BRAIN_SHARED_SECRET: process.env.JWT_SECRET!,
  BRAIN_ENABLED: 'true',
  BRAIN_EMBEDDINGS: 'off',
  LIBRECHAT_TEST_RUN_HOOK: path.resolve(root, 'e2e/setup/fake-brain-model.js'),
};
Object.assign(process.env, brainEnv);
if (process.env.E2E_BRAIN_SEPARATE_MODEL === 'true') {
  const configPath = path.resolve(root, 'e2e/.generated/librechat.e2e.yaml');
  const yaml = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(
    configPath,
    yaml.replace(
      /^memory:\n/m,
      'memory:\n  agent:\n    enabled: true\n    provider: Mock Provider B\n    model: mock-brain-review-model\n  bootstrapAgent:\n    enabled: true\n    provider: Mock Provider B\n    model: mock-brain-bootstrap-model\n',
    ),
  );
}
const servers = base.webServer ? [base.webServer].flat() : [];

export default defineConfig({
  ...base,
  testMatch: 'brain.spec.ts',
  reporter: [['list']],
  webServer: [
    ...servers.map((server, index) => ({
      ...server,
      ...(index === 2 ? { command: 'node e2e/setup/fake-brain-provider.js' } : {}),
      env: { ...process.env, ...server.env, ...brainEnv },
    })),
    {
      command: 'node src/server.js',
      cwd: path.resolve(root, '../services/brain'),
      env: { ...process.env, ...brainEnv, HOST: '127.0.0.1', PORT: port },
      url: `http://127.0.0.1:${port}/health`,
      timeout: 60000,
      reuseExistingServer: false,
    },
  ],
});
