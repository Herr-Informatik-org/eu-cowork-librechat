require('dotenv').config({ quiet: true });
for (const name of Object.keys(process.env)) {
  if (name.startsWith('LANGFUSE_') || name.startsWith('OTEL_EXPORTER_')) delete process.env[name];
}
process.env.OTEL_SDK_DISABLED = 'true';
process.env.LOG_TO_FILE = 'false';
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
const fs = require('fs');
const express = require('express');
const passport = require('passport');
const cookieParser = require('cookie-parser');
const { connectDb } = require('~/db');
const { seedDefaultRoles } = require('~/models');
const { runAsSystem, logger } = require('@librechat/data-schemas');
logger.silent = true;
const { jwtLogin, passportLogin, openIdJwtLogin, setupOpenId } = require('~/strategies');
const { getAppConfig } = require('./services/Config');
const { capabilityContextMiddleware } = require('./middleware/roles/capabilities');
const notebooks = require('./routes/notebooks');

async function start() {
  if (process.env.NOTEBOOKS_ENABLED !== 'true') throw new Error('Der Wissensraum-Pilot ist nicht aktiviert.');
  await connectDb();
  await runAsSystem(seedDefaultRoles);
  const config = await getAppConfig({ baseOnly: true });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
  app.use(cookieParser());
  app.use(passport.initialize());
  passport.use(jwtLogin());
  passport.use(passportLogin());
  if (process.env.OPENID_REUSE_TOKENS === 'true') {
    const openid = await setupOpenId();
    if (!openid) throw new Error('Die bestehende OpenID-Anmeldung konnte nicht initialisiert werden.');
    passport.use('openidJwt', openIdJwtLogin(openid));
  }
  app.use(capabilityContextMiddleware);
  app.get('/health', (_req, res) => res.json({ ready: true, role: 'notebooks', build: process.env.BUILD_COMMIT }));
  app.get('/api/notebooks/app', (_req, res) => res.set('Cache-Control','no-store').sendFile(path.join(config.paths.dist,'index.html')));
  app.use('/api/notebooks', notebooks);
  app.use('/notebooks-assets', express.static(config.paths.dist, { immutable: true, maxAge: '1y', fallthrough: false }));
  app.get('/wissensraeume', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(fs.readFileSync(path.join(config.paths.dist, 'index.html'), 'utf8'));
  });
  app.use((_req, res) => res.status(404).json({ error: 'Dieser Dienst stellt nur den Wissensraum-Piloten bereit.' }));
  app.use((_error, _req, res, _next) => res.status(503).json({ error: 'Der Wissensraum-Pilot ist vorübergehend nicht verfügbar.' }));
  const server = app.listen(3080, '0.0.0.0');
  server.requestTimeout = 120000;
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
  });
  console.log('Wissensraum-Pilot bereit; keine Chat-, Mail- oder MCP-Hintergrundaufträge gestartet.');
}
start().catch(() => { console.error('Der Wissensraum-Pilot konnte nicht sicher starten.'); process.exit(1); });
