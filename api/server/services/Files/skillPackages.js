const api = require('@librechat/api');
const db = require('~/models');
const {
  Permissions,
  PermissionTypes,
  ResourceType,
  PermissionBits,
} = require('librechat-data-provider');
const {
  findAccessibleResources,
  findPubliclyAccessibleResources,
} = require('~/server/services/PermissionService');
const {
  getSkillToolDeps,
  getSkillDbMethods,
  getSkillStrategyFunctions,
  withDeploymentSkillIds,
} = require('~/server/services/Endpoints/agents/skillDeps');
const { getStrategyFunctions } = require('./strategies');
function dependencies() {
  return {
    ...getSkillToolDeps(),
    findFileById: db.findFileById,
    getSkillById: db.getSkillById,
    readFile: async (req, file) => {
      if (file.source !== 'execute_code')
        return getStrategyFunctions(file.source).getDownloadStream(
          req,
          file.storageKey || file.filepath,
        );
      const ref = file.metadata?.codeEnvRef;
      if (!ref || ref.kind !== 'user' || ref.id !== req.user.id)
        throw new Error('Private Quelldatei besitzt keine gültige Speicherzuordnung.');
      return (
        await require('./Code/crud').getCodeOutputDownloadStream(
          ref.storage_session_id + '/' + ref.file_id,
          { kind: 'user', id: req.user.id },
          req,
        )
      ).data;
    },
    readSkillFile: (req, file) =>
      getSkillStrategyFunctions(file.source).getDownloadStream(
        req,
        file.storageKey || file.filepath,
      ),
    findAccessibleSkill: async (req, name) => {
      if (
        !(await api.checkAccess({
          req,
          user: req.user,
          permissionType: PermissionTypes.SKILLS,
          permissions: [Permissions.USE],
          getRoleByName: db.getRoleByName,
        }))
      )
        throw new Error('Keine Berechtigung zur Skill-Nutzung.');
      const [owned, shared] = await Promise.all([
        findAccessibleResources({
          userId: req.user.id,
          role: req.user.role,
          resourceType: ResourceType.SKILL,
          requiredPermissions: PermissionBits.VIEW,
        }),
        findPubliclyAccessibleResources({
          resourceType: ResourceType.SKILL,
          requiredPermissions: PermissionBits.VIEW,
        }),
      ]);
      return getSkillDbMethods().getSkillByName(
        name,
        withDeploymentSkillIds([...owned, ...shared]),
      );
    },
    serviceRequest: (route, body) => require('./documentQuality').serviceRequest(route, body),
  };
}
module.exports = {
  createBuildSkillTool: (req) => api.createBuildSkillTool(req, dependencies()),
  resolveSkillTemplate: (req, path) => api.resolveSkillTemplate(req, path, dependencies()),
  readOwnedTemplate: (req, id) => api.readOwnedTemplate(req, id, dependencies()),
  readOwnedUpload: (req, id) => api.readOwnedUpload(req, id, dependencies()),
};
