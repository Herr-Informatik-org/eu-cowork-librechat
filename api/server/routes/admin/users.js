const express = require('express');
const { createAdminUsersHandlers, invalidateCachedAuthUserDoc } = require('@librechat/api');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);
const requireManageUsers = requireCapability(SystemCapabilities.MANAGE_USERS);

const handlers = createAdminUsersHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  deleteUserById: db.deleteUserById,
  deleteConfig: db.deleteConfig,
  deleteAclEntries: db.deleteAclEntries,
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', requireReadUsers, handlers.listUsers);
router.get('/search', requireReadUsers, handlers.searchUsers);
router.post('/:id/auth-cache', requireManageUsers, async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id))
      return res.status(400).json({ message: 'Ungültige Benutzerkennung.' });
    await invalidateCachedAuthUserDoc(getLogStores(CacheKeys.AUTH_USER_DOC), {
      userId: req.params.id,
    });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});
// router.delete('/:id', requireManageUsers, handlers.deleteUser);

module.exports = router;
