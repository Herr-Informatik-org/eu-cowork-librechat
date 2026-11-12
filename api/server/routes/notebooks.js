const express = require('express');
const { createNotebooksRouter, createNotebookAnswer, checkAccess } = require('@librechat/api');
const db = require('~/models');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const permissions = require('~/server/services/PermissionService');
const { requireJwtAuth, configMiddleware, checkBan } = require('~/server/middleware');
const router = express.Router();
router.use(requireJwtAuth, checkBan, configMiddleware, express.json({ limit: '2mb' }));
router.use(createNotebooksRouter({
  getUserById: db.getUserById,
  canUse: (user) => checkAccess({ user, permissionType: PermissionTypes.FILE_SEARCH, permissions: [Permissions.USE], getRoleByName: db.getRoleByName }),
  permissions: permissions.getEffectivePermissions,
  list: permissions.findAccessibleResources,
  grant: permissions.grantPermission,
  remove: permissions.removeAllPermissions,
  answer: createNotebookAnswer({
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
      logViolation: async () => undefined,
    },
  }),
}));
module.exports = router;
