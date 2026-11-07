const fs = require('fs').promises;
const express = require('express');
const mongoose = require('mongoose');
const {
  createOfficeRouter,
  createMailAssistantRuntime,
  createMailAssistantRouter,
  createMailAssistantCallbackRouter,
  tenantContextMiddleware,
  restoreTenantContextFromReq,
} = require('@librechat/api');
const { ResourceType, PermissionBits } = require('librechat-data-provider');
const {
  requireJwtAuth,
  checkBan,
  uaParser,
  configMiddleware,
  createFileLimiters,
} = require('~/server/middleware');
const { findAccessibleResources } = require('~/server/services/PermissionService');
const { createAgentRouter } = require('./agents');
const {
  preAuthTenantMiddleware,
  requireRemoteAgentAuth,
  checkRemoteAgentsFeature,
} = require('./agents/middleware');
const { createMulterInstance } = require('./files/multer');
const images = require('./files/images');
const db = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

let webRouter;

async function initialize() {
  const upload = await createMulterInstance();
  const { fileUploadIpLimiter, fileUploadUserLimiter } = createFileLimiters();
  const mailAssistant = createMailAssistantRuntime({
    collection: (name) => mongoose.connection.collection(name),
    getUserById: db.getUserById,
    getRoleByName: db.getRoleByName,
    getAppConfig,
    getAccessibleAgent: async (req, agentId) => {
      const ids = await findAccessibleResources({
        userId: req.user.id,
        role: req.user.role,
        resourceType: ResourceType.REMOTE_AGENT,
        requiredPermissions: PermissionBits.VIEW,
      });
      if (!ids.length) return null;
      return db.getAgent({ id: agentId, _id: { $in: ids } });
    },
    checkUserBan: async (ownerId) => {
      let allowed = false;
      await checkBan(
        { user: { id: ownerId }, headers: {}, body: {}, get: () => undefined },
        { status: () => ({ json: () => undefined }) },
        (error) => {
          if (error) throw error;
          allowed = true;
        },
      );
      if (!allowed) throw new Error('Das Benutzerkonto ist gesperrt.');
    },
    audit: db.recordAuditEntry,
    createTransaction: db.createTransaction,
    balance: {
      getMultiplier: db.getMultiplier,
      findBalanceByUser: db.findBalanceByUser,
      createAutoRefillTransaction: db.createAutoRefillTransaction,
      upsertBalanceFields: db.upsertBalanceFields,
    },
  });
  mailAssistant?.engine.start();
  mailAssistant?.research?.start();
  process.once('exit', () => {
    mailAssistant?.engine.stop();
    mailAssistant?.research?.stop();
  });
  webRouter = express.Router();
  webRouter.use(
    requireJwtAuth,
    checkBan,
    configMiddleware,
    createMailAssistantRouter(mailAssistant),
  );
  return createOfficeRouter({
    mailAssistantRouter: createMailAssistantRouter(mailAssistant),
    mailAssistantCallbackRouter: createMailAssistantCallbackRouter(mailAssistant),
    authenticate: [
      preAuthTenantMiddleware,
      requireRemoteAgentAuth,
      tenantContextMiddleware,
      checkRemoteAgentsFeature,
      checkBan,
      uaParser,
    ],
    configure: configMiddleware,
    chatRouter: createAgentRouter({
      authenticate: (_req, _res, next) => next(),
      includeRemoteRoutes: false,
      includeManagementRoutes: false,
    }),
    imageUpload: [
      fileUploadIpLimiter,
      fileUploadUserLimiter,
      upload.single('file'),
      restoreTenantContextFromReq,
    ],
    imageRouter: images,
    cleanupUpload: async (req) => {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    },
    remoteAgentIds: async (req) => {
      const ids = await findAccessibleResources({
        userId: req.user.id,
        role: req.user.role,
        resourceType: ResourceType.REMOTE_AGENT,
        requiredPermissions: PermissionBits.VIEW,
      });
      if (!ids.length) return new Set();
      const agents = await db.getAgents({ _id: { $in: ids } });
      return new Set(agents.map((agent) => agent.id));
    },
    getFiles: db.getFiles,
    getConvo: db.getConvo,
    getConvosByCursor: db.getConvosByCursor,
    getMessages: db.getMessages,
  });
}

function web() {
  if (!webRouter) throw new Error('Der Mail-Bereich wurde noch nicht initialisiert.');
  return webRouter;
}

module.exports = { initialize, web };
