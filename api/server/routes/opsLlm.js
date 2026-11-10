const mongoose = require('mongoose');
const { createOpsLlmRouters } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { getAppConfig } = require('~/server/services/Config');

module.exports = createOpsLlmRouters({
  collection: (name) => mongoose.connection.db.collection(name, { timeoutMS: 5000 }),
  getCentralConfig: () => getAppConfig({ role: '__base__', refresh: true }),
  getCentralAgent: (id) =>
    mongoose.connection.db.collection('agents', { timeoutMS: 5000 }).findOne({ id }),
  authorizeAdmin: async (req) => {
    const id = req.user?.id ?? req.user?._id?.toString();
    if (!id || !/^[a-f0-9]{24}$/i.test(String(id)) || req.user?.tenantId != null) return false;
    const [user, ban] = await Promise.all([
      mongoose.connection.db
        .collection('users', { timeoutMS: 5000 })
        .findOne({ _id: new mongoose.Types.ObjectId(id) }),
      mongoose.connection.db.collection('logs', { timeoutMS: 5000 }).findOne({ key: `BANS:${id}` }),
    ]);
    if (!user || user.tenantId != null || user.role !== 'ADMIN' || !user.emailVerified)
      return false;
    if (
      user.expiresAt != null &&
      (!Number.isFinite(new Date(user.expiresAt).getTime()) ||
        new Date(user.expiresAt).getTime() <= Date.now())
    )
      return false;
    if (ban) {
      try {
        const record = JSON.parse(ban.value);
        const expires = Number(record.value?.expiresAt ?? record.expires);
        if (!Number.isFinite(expires) || expires > Date.now()) return false;
      } catch {
        return false;
      }
    }
    const principal = { id, role: user.role, idOnTheSource: user.idOnTheSource ?? null };
    return hasCapability(principal, SystemCapabilities.MANAGE_CONFIGS);
  },
});
