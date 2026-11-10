const mongoose = require('mongoose');
const { Permissions, PermissionTypes } = require('librechat-data-provider');
const {
  OpsPersonalService,
  createOpsPersonalSkillAccess,
  isDeploymentSkillId,
  createMongoOpsPersonalStore,
  createOpsPersonalRouter,
  configureOpsPersonal,
  checkAccess,
  isPersonalMailMemoryAllowed,
  readPersonalMailContext,
} = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { getAppConfig } = require('~/server/services/Config');
const {
  getSkillDbMethods,
  withDeploymentSkillIds,
} = require('~/server/services/Endpoints/agents/skillDeps');

const skills = getSkillDbMethods();
const skillAccess = createOpsPersonalSkillAccess({
  collection: (model) =>
    mongoose.connection.db.collection(mongoose.models[model].collection.collectionName),
  deploymentIds: async () => (await withDeploymentSkillIds([])).map(String),
  isDeploymentSkill: isDeploymentSkillId,
  deploymentSkill: async (id) => {
    const skill = await skills.getSkillById(id);
    return skill
      ? {
          id: String(skill._id),
          name: skill.name,
          version: String(skill.version),
          body: skill.body,
          userInvocable: skill.userInvocable,
        }
      : null;
  },
});
const currentRole = async (name) =>
  mongoose.connection.db
    .collection(mongoose.models.Role.collection.collectionName, { timeoutMS: 5000 })
    .findOne({ name, tenantId: null });
const service = new OpsPersonalService(
  createMongoOpsPersonalStore(() =>
    mongoose.connection.db.collection('eucowork_ops_personal_grants', { timeoutMS: 5000 }),
  ),
  {
    currentUser: async (ownerId) => {
      if (!/^[a-f0-9]{24}$/.test(ownerId)) return null;
      const [user, ban] = await Promise.all([
        mongoose.connection.db
          .collection('users', { timeoutMS: 5000 })
          .findOne({ _id: new mongoose.Types.ObjectId(ownerId) }),
        mongoose.connection.db
          .collection('logs', { timeoutMS: 5000 })
          .findOne({ key: `BANS:${ownerId}` }),
      ]);
      if (
        !user ||
        user.role === 'KISUNO_SUPPORT_RUNTIME' ||
        user.provider === 'kisuno-support-runtime'
      )
        return null;
      if (ban) {
        try {
          const record = JSON.parse(ban.value);
          const expires = Number(record.value?.expiresAt ?? record.expires);
          if (!Number.isFinite(expires) || expires > Date.now()) return null;
        } catch {
          return null;
        }
      }
      return { ...user, id: String(user._id) };
    },
    config: async (user) => skillAccess.config(user, await getAppConfig({ baseOnly: true })),
    skillsAllowed: (user) =>
      checkAccess({
        user,
        permissionType: PermissionTypes.SKILLS,
        permissions: [Permissions.USE],
        getRoleByName: currentRole,
      }),
    brainAllowed: (req) => isPersonalMailMemoryAllowed(req, currentRole),
    skillIds: (user) => skillAccess.ids(user),
    skill: (id) => skillAccess.get(id),
    mailContext: (req, input) => readPersonalMailContext(req, currentRole, input),
  },
);
configureOpsPersonal(service);
module.exports = createOpsPersonalRouter(service, requireJwtAuth);
