'use strict';

const http = require('node:http');

const { loadConfig } = require('./config');
const { createRemoteJwksVerifier, verifyBearerAuth } = require('./auth/verify-token');
const { can } = require('./auth/roles');
const { createMemoryStore } = require('./db/memory-store');

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function errorBody(code, message) {
  return { error: { code, message } };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function authenticate(req, { store, verifyToken }) {
  const claims = await verifyBearerAuth(req.headers, verifyToken);
  const user = store.upsertUserFromClaims(claims);
  return { claims, user };
}

function requireMembership(store, userId, organizationId, permission) {
  const membership = store.membershipFor(userId, organizationId);
  if (!membership) {
    const err = new Error('Organization membership required');
    err.status = 403;
    err.code = 'forbidden';
    throw err;
  }
  if (permission && !can(membership.role, permission)) {
    const err = new Error('Permission denied');
    err.status = 403;
    err.code = 'forbidden';
    throw err;
  }
  return membership;
}

function createServer({
  config = loadConfig(),
  logger = console,
  store = createMemoryStore(),
  verifyToken = createRemoteJwksVerifier({
    issuer: config.oidcIssuer,
    audience: config.oidcAudience,
    jwksUrl: config.oidcJwksUrl,
  }),
} = {}) {
  return http.createServer((req, res) => {
    const run = async () => {
      const url = new URL(req.url, 'http://ledgerly.local');
      try {
        if (req.method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, {
            ok: true,
            service: 'ledgerly-cloud',
            appEnv: config.appEnv,
          });
          return;
        }

        if (url.pathname.startsWith('/v1/')) {
          if (!req.headers.authorization) {
            sendJson(res, 401, errorBody('unauthorized', 'Missing bearer token'));
            return;
          }
          const { user } = await authenticate(req, { store, verifyToken });

          if (req.method === 'GET' && url.pathname === '/v1/me') {
            sendJson(res, 200, {
              user,
              organizations: store.listOrganizationsForUser(user.id),
            });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/v1/organizations') {
            sendJson(res, 200, {
              organizations: store.listOrganizationsForUser(user.id),
            });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/v1/organizations') {
            const body = await readJson(req);
            const created = store.createOrganization({ userId: user.id, name: body.name });
            sendJson(res, 201, created);
            return;
          }

          const registerMatch = /^\/v1\/organizations\/([^/]+)\/devices\/register$/.exec(url.pathname);
          if (req.method === 'POST' && registerMatch) {
            const organizationId = decodeURIComponent(registerMatch[1]);
            requireMembership(store, user.id, organizationId, 'devices.manage');
            const body = await readJson(req);
            sendJson(res, 201, {
              device: store.registerDevice({
                userId: user.id,
                organizationId,
                deviceName: body.deviceName,
                publicKey: body.publicKey,
              }),
            });
            return;
          }

          const revokeMatch = /^\/v1\/organizations\/([^/]+)\/devices\/([^/]+)\/revoke$/.exec(url.pathname);
          if (req.method === 'POST' && revokeMatch) {
            const organizationId = decodeURIComponent(revokeMatch[1]);
            const deviceId = decodeURIComponent(revokeMatch[2]);
            requireMembership(store, user.id, organizationId, 'devices.manage');
            sendJson(res, 200, {
              device: store.revokeDevice({ userId: user.id, organizationId, deviceId }),
            });
            return;
          }
        }

        sendJson(res, 404, errorBody('not_found', 'Route not found'));
      } catch (err) {
        if (err.message === 'Missing bearer token') {
          sendJson(res, 401, errorBody('unauthorized', 'Missing bearer token'));
          return;
        }
        if (/token|Auth verifier/i.test(err.message)) {
          sendJson(res, 401, errorBody('unauthorized', err.message));
          return;
        }
        if (err.status === 403) {
          sendJson(res, 403, errorBody(err.code || 'forbidden', err.message));
          return;
        }
        if (/required|Invalid JSON body/.test(err.message)) {
          sendJson(res, 400, errorBody('bad_request', err.message));
          return;
        }
        logger.error?.('request_failed', { message: err.message });
        sendJson(res, 500, errorBody('internal_error', 'Internal server error'));
      }
    };
    run();
  });
}

if (require.main === module) {
  const config = loadConfig();
  const server = createServer({ config });
  server.listen(config.port, () => {
    console.log(`Ledgerly Cloud listening on ${config.port}`);
  });
}

module.exports = {
  createServer,
};
