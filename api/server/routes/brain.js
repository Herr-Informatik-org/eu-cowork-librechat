const express = require('express');
const mongoose = require('mongoose');
const {
  createBrainRouter,
  createMongoBrainHistoryStore,
  createBrainHistoryRuntime,
} = require('@librechat/api');
const db = require('~/models');
const { reportBrainFailure } = require('~/server/services/BrainDiagnostics');
const { getAppConfig } = require('~/server/services/Config');
const { getAccessibleMcpServerNames, userCanUseMCPServers } = require('~/server/services/MCP');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');

const router = express.Router();
router.use(requireJwtAuth, configMiddleware, express.json({ limit: '100kb' }));
const history = createBrainHistoryRuntime({
  connectionHints: async (req) => {
    if (!(await userCanUseMCPServers(req.user, req))) return [];
    const names = await getAccessibleMcpServerNames(String(req.user.id), req.user.role);
    return names
      .filter((name) => /^[\p{L}\p{N} ._-]{1,80}$/u.test(name))
      .sort()
      .slice(0, 30);
  },
  reportFailure: reportBrainFailure,
  store: createMongoBrainHistoryStore({
    jobs: () => mongoose.connection.collection('eucowork_brain_history'),
    messages: () => mongoose.connection.collection('messages'),
    tombstones: () => mongoose.connection.collection('eucowork_brain_tombstones'),
  }),
  getUserById: db.getUserById,
  getRoleByName: db.getRoleByName,
  getAppConfig,
  db: { getUserKey: db.getUserKey, getUserKeyValues: db.getUserKeyValues },
  usage: {
    spendTokens: db.spendTokens,
    spendStructuredTokens: db.spendStructuredTokens,
    pricing: { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier },
    bulkWriteOps: { insertMany: db.bulkInsertTransactions, updateBalance: db.updateBalance },
  },
  balance: {
    getMultiplier: db.getMultiplier,
    findBalanceByUser: db.findBalanceByUser,
    createAutoRefillTransaction: db.createAutoRefillTransaction,
    upsertBalanceFields: db.upsertBalanceFields,
  },
});
router.use(
  createBrainRouter({
    getRoleByName: db.getRoleByName,
    history,
    reportFailure: reportBrainFailure,
  }),
);

module.exports = router;
