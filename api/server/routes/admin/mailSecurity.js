const express = require('express');
const mongoose = require('mongoose');
const { createMailSecurityAdminRouter, MAIL_SECURITY_COLLECTION } = require('@librechat/api');
const { SystemCapabilities } = require('@librechat/data-schemas');
const { requireJwtAuth, checkBan } = require('~/server/middleware');
const {
  hasCapability,
  hasConfigCapability,
  requireCapability,
} = require('~/server/middleware/roles/capabilities');
const db = require('~/models');

const router = express.Router();
router.use(requireJwtAuth, checkBan, requireCapability(SystemCapabilities.ACCESS_ADMIN));
router.use(
  createMailSecurityAdminRouter({
    collection: () => mongoose.connection.collection(MAIL_SECURITY_COLLECTION),
    authorize: async (req) => {
      const id = req.user?.id ?? req.user?._id?.toString();
      if (!id || req.user?.tenantId) return null;
      const user = await db.getUserById(id);
      if (!user || user.tenantId) return null;
      const principal = { id, role: user.role, idOnTheSource: user.idOnTheSource ?? null };
      if (!(await hasCapability(principal, SystemCapabilities.ACCESS_ADMIN))) return null;
      return (await hasConfigCapability(principal, 'interface')) ? { id } : null;
    },
    audit: db.recordAuditEntry,
  }),
);
module.exports = router;
