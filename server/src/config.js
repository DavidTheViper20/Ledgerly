'use strict';

// Auth modes:
// - 'oidc'   (default): Auth0/OIDC JWT verification via JWKS. Track B.
// - 'static': one shared bearer token for a single-user deployment. Track A —
//   lets staging run David's own bank feeds before an Auth0 tenant exists.
const AUTH_MODES = ['oidc', 'static'];
const STATIC_TOKEN_MIN_LENGTH = 32;

const BASE_REQUIRED_KEYS = [
  'APP_ENV',
  'DATABASE_URL',
  'BASIQ_API_KEY',
  'CORS_ORIGINS',
];
const OIDC_REQUIRED_KEYS = [
  'OIDC_ISSUER',
  'OIDC_AUDIENCE',
];

// Kept for compatibility with existing tests/docs: the full oidc-mode set.
const REQUIRED_KEYS = [...BASE_REQUIRED_KEYS.slice(0, 2), ...OIDC_REQUIRED_KEYS, ...BASE_REQUIRED_KEYS.slice(2)];

function valueOf(env, key) {
  return String(env[key] || '').trim();
}

function parseCorsOrigins(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function defaultJwksUrl(issuer) {
  return `${String(issuer || '').replace(/\/+$/, '')}/.well-known/jwks.json`;
}

function resolveAuthMode(env) {
  const explicit = valueOf(env, 'CLOUD_AUTH_MODE').toLowerCase();
  if (explicit) {
    if (!AUTH_MODES.includes(explicit)) {
      throw new Error(`Invalid config: CLOUD_AUTH_MODE must be one of ${AUTH_MODES.join(', ')}`);
    }
    return explicit;
  }
  return valueOf(env, 'CLOUD_STATIC_TOKEN') ? 'static' : 'oidc';
}

function loadConfig(env = process.env) {
  const authMode = resolveAuthMode(env);
  const requiredKeys = authMode === 'static' ? BASE_REQUIRED_KEYS : REQUIRED_KEYS;
  const missing = requiredKeys.filter(key => !valueOf(env, key));
  if (missing.length) throw new Error(`Missing required config: ${missing.join(', ')}`);

  const staticToken = valueOf(env, 'CLOUD_STATIC_TOKEN');
  if (authMode === 'static' && staticToken.length < STATIC_TOKEN_MIN_LENGTH) {
    throw new Error(`Invalid config: CLOUD_STATIC_TOKEN must be at least ${STATIC_TOKEN_MIN_LENGTH} characters`);
  }

  const port = Number(valueOf(env, 'PORT') || 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid config: PORT must be an integer from 0 to 65535');
  }

  const corsOrigins = parseCorsOrigins(env.CORS_ORIGINS);
  if (!corsOrigins.length) throw new Error('Invalid config: CORS_ORIGINS must include at least one origin');

  return Object.freeze({
    appEnv: valueOf(env, 'APP_ENV'),
    port,
    authMode,
    staticToken,
    databaseUrl: valueOf(env, 'DATABASE_URL'),
    oidcIssuer: valueOf(env, 'OIDC_ISSUER'),
    oidcAudience: valueOf(env, 'OIDC_AUDIENCE'),
    oidcJwksUrl: valueOf(env, 'OIDC_JWKS_URL') || defaultJwksUrl(valueOf(env, 'OIDC_ISSUER')),
    basiqApiKey: valueOf(env, 'BASIQ_API_KEY'),
    corsOrigins,
  });
}

function safeConfigSummary(config) {
  return {
    appEnv: config.appEnv,
    port: config.port,
    authMode: config.authMode,
    oidcIssuer: config.oidcIssuer,
    oidcAudience: config.oidcAudience,
    corsOrigins: config.corsOrigins,
    hasDatabaseUrl: Boolean(config.databaseUrl),
    hasBasiqApiKey: Boolean(config.basiqApiKey),
    hasStaticToken: Boolean(config.staticToken),
  };
}

module.exports = {
  AUTH_MODES,
  REQUIRED_KEYS,
  STATIC_TOKEN_MIN_LENGTH,
  loadConfig,
  safeConfigSummary,
};
