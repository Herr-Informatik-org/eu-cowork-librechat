const {
  executeSupportAnalysis,
  getSupportRuntimeStatus,
  SupportRuntimeError,
  SUPPORT_RUNTIME_PROFILE,
} = require('@librechat/api');
const db = require('~/models');

module.exports = async function SupportAnalysisController(req, res) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  try {
    const result = await executeSupportAnalysis(req, controller.signal, {
      getAgent: db.getAgent,
      usage: {
        spendTokens: db.spendTokens,
        spendStructuredTokens: db.spendStructuredTokens,
        pricing: { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier },
        bulkWriteOps: { insertMany: db.bulkInsertTransactions, updateBalance: db.updateBalance },
      },
    });
    res.set('Cache-Control', 'no-store');
    res.set('X-Kisuno-Runtime-Profile', SUPPORT_RUNTIME_PROFILE);
    res.json(result);
  } catch (error) {
    const status = error instanceof SupportRuntimeError ? error.status : 502;
    const code = error instanceof SupportRuntimeError ? error.code : 'support_runtime_failed';
    res.status(status).json({
      error: { code, message: 'Supportanalyse konnte nicht sicher abgeschlossen werden.' },
    });
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
  }
};

module.exports.status = async function SupportStatusController(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await getSupportRuntimeStatus(req, { getAgent: db.getAgent });
    res.set('X-Kisuno-Runtime-Profile', SUPPORT_RUNTIME_PROFILE);
    res.json(result);
  } catch (error) {
    const status = error instanceof SupportRuntimeError ? error.status : 503;
    const code = error instanceof SupportRuntimeError ? error.code : 'support_runtime_unavailable';
    res
      .status(status)
      .json({ error: { code, message: 'Supportanalyse ist noch nicht einsatzbereit.' } });
  }
};
