'use strict';

const REQUIRED_KEYS = [
  'APP_ENV',
  'DATABASE_URL',
  'OIDC_ISSUER',
  'OIDC_AUDIENCE',
  'BASIQ_API_KEY',
  'CORS_ORIGINS',
];

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

function loadConfig(env = process.env) {
  const missing = REQUIRED_KEYS.filter(key => !valueOf(env, key));
  if (missing.length) throw new Error(`Missing required config: ${missing.join(', ')}`);

  const port = Number(valueOf(env, 'PORT') || 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid config: PORT must be an integer from 0 to 65535');
  }

  const corsOrigins = parseCorsOrigins(env.CORS_ORIGINS);
  if (!corsOrigins.length) throw new Error('Invalid config: CORS_ORIGINS must include at least one origin');

  return Object.freeze({
    appEnv: valueOf(env, 'APP_ENV'),
    port,
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
    oidcIssuer: config.oidcIssuer,
    oidcAudience: config.oidcAudience,
    corsOrigins: config.corsOrigins,
    hasDatabaseUrl: Boolean(config.databaseUrl),
    hasBasiqApiKey: Boolean(config.basiqApiKey),
  };
}

module.exports = {
  REQUIRED_KEYS,
  loadConfig,
  safeConfigSummary,
};
