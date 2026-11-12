const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const { accessAllowed, requiredSecurity, automationAllowed } = require('@librechat/api');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const { getUserById, updateUser } = require('~/models');

// JWT strategy
const jwtLogin = () =>
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET,
      algorithms: ['HS256'],
      passReqToCallback: true,
    },
    async (req, payload, done) => {
      try {
        if (!payload?.id || (payload.tokenPurpose && payload.tokenPurpose !== 'admin-automation'))
          return done(null, false);
        const user = await getUserById(payload?.id, '-password -__v -totpSecret -backupCodes');
        if (
          user &&
          (automationAllowed(
            payload,
            { ...user, id: String(user._id) },
            req.originalUrl,
            req.method,
          ) ||
            accessAllowed(
              payload,
              { ...user, id: String(user._id) },
              requiredSecurity(),
              Number(process.env.MFA_POLICY_ACTIVE_SINCE) || 0,
            ))
        ) {
          user.id = user._id.toString();
          /** Absent on the full doc means local user; null skips getUserPrincipals' fallback lookup */
          user.idOnTheSource ??= null;
          if (!user.role) {
            user.role = SystemRoles.USER;
            await updateUser(user.id, { role: user.role });
          }
          req.verifiedAuthClaims = payload;
          done(null, user);
        } else {
          logger.warn('[jwtLogin] JwtStrategy => no user found: ' + payload?.id);
          done(null, false);
        }
      } catch (err) {
        done(err, false);
      }
    },
  );

module.exports = jwtLogin;
