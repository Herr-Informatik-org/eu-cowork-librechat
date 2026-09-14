const express = require('express');
const mongoose = require('mongoose');
const {
  createBrainRouter,
  createMongoBrainHistoryStore,
  createBrainHistoryRuntime,
} = require('@librechat/api');
const db = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');

const router = express.Router();
router.use(requireJwtAuth, configMiddleware, express.json({ limit: '100kb' }));
const history = createBrainHistoryRuntime({
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
router.use(createBrainRouter({ getRoleByName: db.getRoleByName, history }));

module.exports = router;
