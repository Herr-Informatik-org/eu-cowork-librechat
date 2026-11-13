const bcrypt = require('bcryptjs');
const { logger } = require('@librechat/data-schemas');
const { Strategy: PassportLocalStrategy } = require('passport-local');
const {
  isEnabled,
  checkEmailConfig,
  comparePassword,
  isSupportServiceIdentity,
} = require('@librechat/api');
const { findUser, updateUser } = require('~/models');
const { loginSchema } = require('./validators');

// Unix timestamp for 2024-06-07 15:20:18 Eastern Time
const verificationEnabledTimestamp = 1717788018;
const invalidCredentialsMessage = 'E-Mail oder Passwort stimmt nicht.';

async function passportLogin(req, email, password, done) {
  try {
    if (!loginSchema.safeParse(req.body).success) {
      logError('Passport Local Strategy - Validation Error', { email: req.body?.email });
      logger.error(`[Login] [Login failed] [Username: ${email}] [Request-IP: ${req.ip}]`);
      return done(null, false, { message: invalidCredentialsMessage });
    }

    const user = await findUser({ email: email.trim() }, '+password');
    const interactiveUser = user && !isSupportServiceIdentity(user) ? user : null;
    const isMatch = await comparePassword(interactiveUser, password, { compare: bcrypt.compare });
    if (!interactiveUser || !isMatch) {
      logError('Lokale Anmeldung: ungültige Zugangsdaten', { email });
      logger.error(`[Login] [Login failed] [Username: ${email}] [Request-IP: ${req.ip}]`);
      return done(null, false, { message: invalidCredentialsMessage });
    }

    const emailEnabled = checkEmailConfig();
    const userCreatedAtTimestamp = Math.floor(new Date(user.createdAt).getTime() / 1000);

    if (
      !emailEnabled &&
      !user.emailVerified &&
      userCreatedAtTimestamp < verificationEnabledTimestamp
    ) {
      await updateUser(user._id, { emailVerified: true });
      user.emailVerified = true;
    }

    const unverifiedAllowed = isEnabled(process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN);
    if (user.expiresAt && unverifiedAllowed) {
      await updateUser(user._id, {});
    }

    if (!user.emailVerified && !unverifiedAllowed) {
      logError('Passport Local Strategy - Email not verified', { email });
      logger.error(`[Login] [Login failed] [Username: ${email}] [Request-IP: ${req.ip}]`);
      return done(null, user, { message: 'Email not verified.' });
    }

    logger.info(`[Login] [Login successful] [Username: ${email}] [Request-IP: ${req.ip}]`);
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}

function logError(title, parameters) {
  const entries = Object.entries(parameters).map(([name, value]) => ({ name, value }));
  logger.error(title, { parameters: entries });
}

module.exports = () =>
  new PassportLocalStrategy(
    {
      usernameField: 'email',
      passwordField: 'password',
      session: false,
      passReqToCallback: true,
    },
    passportLogin,
  );
