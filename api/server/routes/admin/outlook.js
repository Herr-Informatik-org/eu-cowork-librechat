const express = require('express');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { createOutlookAdminRouter } = require('@librechat/api');
const { requireJwtAuth, checkBan } = require('~/server/middleware');
const {
  requireCapability,
  hasCapability,
  hasConfigCapability,
} = require('~/server/middleware/roles/capabilities');
const db = require('~/models');
const router = express.Router();
router.use(requireJwtAuth, checkBan, requireCapability(SystemCapabilities.ACCESS_ADMIN));
router.use(async (req, res, next) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.sendStatus(403);
    const principal = {
      id: req.user.id,
      role: user.role,
      idOnTheSource: user.idOnTheSource ?? null,
    };
    if (
      !(await hasCapability(principal, SystemCapabilities.ACCESS_ADMIN)) ||
      !(await hasConfigCapability(principal, 'interface'))
    )
      return res.status(403).json({ error: 'Die Konfigurationsberechtigung fehlt.' });
    next();
  } catch {
    res.status(503).json({ error: 'Die Administratorrechte konnten nicht geprüft werden.' });
  }
});
router.use(createOutlookAdminRouter());
module.exports = router;
