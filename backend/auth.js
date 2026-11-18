// auth.js — OneLogin OIDC authentication via Passport
// Required env vars (set in .env):
//   OIDC_ISSUER, OIDC_AUTH_URL, OIDC_TOKEN_URL, OIDC_USERINFO_URL
//   OIDC_CLIENT_ID, OIDC_CLIENT_SECRET
//   SESSION_SECRET  (use a long random string in production)
//   ALLOWED_EMAIL_DOMAIN  (default: @amagi.com)

'use strict';

const passport              = require('passport');
const OpenIDConnectStrategy = require('passport-openidconnect').Strategy;

const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || '@amagi.com';
const IS_CONFIGURED  = !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID);

// ── OIDC Strategy (only registered when env vars are present) ─────────────────
if (IS_CONFIGURED) {
  passport.use(
    new OpenIDConnectStrategy(
      {
        issuer:           process.env.OIDC_ISSUER,
        authorizationURL: process.env.OIDC_AUTH_URL,
        tokenURL:         process.env.OIDC_TOKEN_URL,
        userInfoURL:      process.env.OIDC_USERINFO_URL,
        clientID:         process.env.OIDC_CLIENT_ID,
        clientSecret:     process.env.OIDC_CLIENT_SECRET,
        callbackURL:      process.env.OIDC_CALLBACK_URL || '/auth/callback',
        scope:            'openid profile email',
        passReqToCallback: false,
      },
      function verify(issuer, sub, profile, accessToken, refreshToken, done) {
        // Extract email — OneLogin puts it in emails[0].value
        const emails = profile.emails || [];
        const email  = emails[0]?.value || profile._json?.email || '';

        if (!email) {
          console.warn('[auth] OIDC callback: no email in profile', profile);
          return done(null, false, { message: 'No email in profile' });
        }

        if (!email.toLowerCase().endsWith(ALLOWED_DOMAIN.toLowerCase())) {
          console.warn(`[auth] Access denied for ${email} — not ${ALLOWED_DOMAIN}`);
          return done(null, false, { message: `Access restricted to ${ALLOWED_DOMAIN} accounts` });
        }

        console.log(`[auth] Login success: ${email}`);

        const user = {
          sub,
          email,
          name:       profile.displayName || profile.name?.givenName || email.split('@')[0],
          given_name: profile.name?.givenName || '',
          family_name:profile.name?.familyName || '',
        };

        return done(null, user);
      }
    )
  );

  console.log(`[auth] OIDC configured — issuer: ${process.env.OIDC_ISSUER}`);
} else {
  console.log('[auth] OIDC env vars not set — running in DEV BYPASS mode (all requests treated as authenticated)');
}

// ── Session serialization ─────────────────────────────────────────────────────
passport.serializeUser((user, done)  => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// ── Auth middleware ───────────────────────────────────────────────────────────

/**
 * requireAuth — Express middleware.
 * Blocks unauthenticated requests with 401.
 * In DEV BYPASS mode (no OIDC config), all requests pass through.
 */
function requireAuth(req, res, next) {
  if (!IS_CONFIGURED) {
    // Dev bypass: inject a synthetic user so /auth/me still returns something useful
    if (!req.user) {
      req.user = {
        email:       'dev@amagi.com',
        name:        'Dev User',
        given_name:  'Dev',
        family_name: 'User',
        _bypass:     true,
      };
    }
    return next();
  }

  if (req.isAuthenticated()) return next();

  // Ajax / API requests get 401 JSON
  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'Unauthorized', redirect: '/auth/login' });
  }

  // Browser navigation → redirect to login
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/login');
}

/**
 * requireAuthApi — like requireAuth but always returns JSON 401.
 * Applied to /api/* routes explicitly.
 */
function requireAuthApi(req, res, next) {
  if (!IS_CONFIGURED) {
    if (!req.user) req.user = { email: 'dev@amagi.com', name: 'Dev User', _bypass: true };
    return next();
  }
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Unauthorized', login_url: '/auth/login' });
}

module.exports = {
  passport,
  requireAuth,
  requireAuthApi,
  IS_CONFIGURED,
  ALLOWED_DOMAIN,
};
