const { releaseLifecycle } = require('@librechat/api');
if (process.env.KISUNO_RELEASE_ID && !releaseLifecycle) {
  throw new Error('Release-Laufzeit fehlt im API-Paket.');
}
module.exports = releaseLifecycle || { enabled: false, runTask: (_name, run) => run() };
