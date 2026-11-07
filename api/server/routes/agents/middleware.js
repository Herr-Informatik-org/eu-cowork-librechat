const { PermissionTypes, Permissions } = require('librechat-data-provider');
const {
  generateCheckAccess,
  preAuthTenantMiddleware,
  createRequireApiKeyAuth,
  createRemoteAgentAuth,
  createCheckRemoteAgentAccess,
  restrictSupportServiceRoute,
} = require('@librechat/api');
const { getEffectivePermissions } = require('~/server/services/PermissionService');
const { getAppConfig } = require('~/server/services/Config');
const db = require('~/models');

const apiKeyMiddleware = createRequireApiKeyAuth({
  validateAgentApiKey: db.validateAgentApiKey,
  findUser: db.findUser,
});

const authenticateRemoteAgent = createRemoteAgentAuth({
  apiKeyMiddleware,
  findUser: db.findUser,
  getRolesByNames: db.findRolesByNames,
  updateUser: db.updateUser,
  getAppConfig,
});

const requireRemoteAgentAuth = (req, res, next) =>
  authenticateRemoteAgent(req, res, () => restrictSupportServiceRoute(req, res, next));

const checkRemoteAgentsFeature = generateCheckAccess({
  permissionType: PermissionTypes.REMOTE_AGENTS,
  permissions: [Permissions.USE],
  getRoleByName: db.getRoleByName,
});

const checkAgentPermission = createCheckRemoteAgentAccess({
  getAgent: db.getAgent,
  getEffectivePermissions,
});

module.exports = {
  checkAgentPermission,
  preAuthTenantMiddleware,
  requireRemoteAgentAuth,
  checkRemoteAgentsFeature,
};
