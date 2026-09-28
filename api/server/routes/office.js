const fs = require('fs').promises;
const {
  createOfficeRouter,
  tenantContextMiddleware,
  restoreTenantContextFromReq,
} = require('@librechat/api');
const { ResourceType, PermissionBits } = require('librechat-data-provider');
const { checkBan, uaParser, configMiddleware, createFileLimiters } = require('~/server/middleware');
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

async function initialize() {
  const upload = await createMulterInstance();
  const { fileUploadIpLimiter, fileUploadUserLimiter } = createFileLimiters();
  return createOfficeRouter({
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

module.exports = { initialize };
