const mongoose = require('mongoose');
const {
  createSecurityEngine,
  createSecurityStore,
  createSecurityAccounts,
  resolveSecurityConfig,
  invalidateCachedAuthUserDoc,
} = require('@librechat/api');
const { encryptV3, SystemCapabilities } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const { getLogStores } = require('~/cache');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { getUserById } = require('~/models');
const { generateTOTPSecret, getTOTPSecret, verifyTOTP } = require('./twoFactorService');

let engine;
const invalidate = (userId) =>
  invalidateCachedAuthUserDoc(getLogStores(CacheKeys.AUTH_USER_DOC), { userId });

const getSecurityEngine = () => {
  if (!engine)
    engine = (async () => {
      const db = mongoose.connection.db;
      const accounts = createSecurityAccounts(db, 'users', invalidate);
      const store = await createSecurityStore(db, accounts);
      const audit = db.collection('kisuno_security_audit');
      await audit.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });
      return createSecurityEngine({
        config: resolveSecurityConfig(),
        store,
        encrypt: encryptV3,
        decrypt: getTOTPSecret,
        secret: generateTOTPSecret,
        verifyTotp: verifyTOTP,
        admin: (user) =>
          hasCapability(
            { ...user, _id: new mongoose.Types.ObjectId(user.id) },
            SystemCapabilities.ACCESS_ADMIN,
          ),
        audit: (user, action) =>
          audit.insertOne({ userId: user.id, action, createdAt: new Date() }),
        issue: async (user, proof, req, res) => {
          req.user = await getUserById(
            user.id,
            '-password -__v -totpSecret -backupCodes -pendingTotpSecret -pendingBackupCodes -federatedTokens -refreshToken',
          );
          const { checkBan } = require('~/server/middleware');
          let allowed = false;
          await checkBan(req, res, () => {
            allowed = true;
          });
          if (!allowed) throw Object.assign(new Error('Anmeldung ist gesperrt.'), { status: 403 });
          req.securityAssurance = proof;
          const { setAuthTokens } = require('./AuthService');
          const token = await setAuthTokens(user.id, res, null, req);
          return { token, user: { ...req.user, id: user.id } };
        },
      });
    })().catch((error) => {
      engine = null;
      throw error;
    });
  return engine;
};

const beginSecurityLogin = async (req, res) => {
  const user = req.user;
  const security = await getSecurityEngine();
  return security.begin({ ...user, id: String(user._id || user.id) }, req, res);
};

module.exports = { getSecurityEngine, beginSecurityLogin };
