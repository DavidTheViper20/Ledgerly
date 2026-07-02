'use strict';

const http = require('node:http');

const { loadConfig } = require('./config');
const { createRemoteJwksVerifier, verifyBearerAuth } = require('./auth/verify-token');
const { createStaticTokenVerifier } = require('./auth/static-token');
const { can } = require('./auth/roles');
const { createMemoryStore } = require('./db/memory-store');
const { createPostgresStore } = require('./db/postgres-store');
const { createBasiqClient } = require('./providers/basiq-client');
const { scrubSensitive } = require('./security/scrub');

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

function createRateLimiter({ windowMs = 60_000, max = 120 } = {}) {
  const buckets = new Map();
  return function checkRateLimit(req) {
    if (!max || max < 1) return null;
    const now = Date.now();
    const key = req.headers.authorization || req.socket.remoteAddress || 'anonymous';
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= max) return null;
    return { retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  };
}

async function authenticate(req, { store, verifyToken }) {
  const claims = await verifyBearerAuth(req.headers, verifyToken);
  const user = await store.upsertUserFromClaims(claims);
  return { claims, user };
}

async function requireMembership(store, userId, organizationId, permission) {
  const membership = await store.membershipFor(userId, organizationId);
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

async function ensureBasiqUser({ store, basiqClient, organizationId, email, mobile }) {
  const existing = await store.getBankProviderUser({ organizationId, provider: 'basiq' });
  if (existing) return existing;
  const user = await basiqClient.createUser({ email, mobile });
  return store.upsertBankProviderUser({
    organizationId,
    provider: 'basiq',
    providerUserId: user.id,
  });
}

async function connectionOrError(store, organizationId) {
  const connection = await store.firstBankFeedConnection({ organizationId, provider: 'basiq' });
  if (!connection) {
    const err = new Error('Bank feed connection not found');
    err.status = 404;
    err.code = 'not_found';
    throw err;
  }
  return connection;
}

async function accountOrError(store, organizationId, providerAccountId) {
  const found = await store.bankFeedAccountByProvider({ organizationId, providerAccountId });
  if (!found) {
    const err = new Error('Bank feed account link not found');
    err.status = 404;
    err.code = 'not_found';
    throw err;
  }
  return found;
}

function consentActiveOrError(connection) {
  if (connection.revokedAt || connection.consentStatus === 'revoked') {
    const err = new Error('Bank feed consent is revoked');
    err.status = 409;
    err.code = 'consent_revoked';
    throw err;
  }
}

function createDefaultStore(config) {
  if (config.appEnv === 'test' || !config.databaseUrl) return createMemoryStore();
  return createPostgresStore({ databaseUrl: config.databaseUrl });
}

function createDefaultVerifier(config) {
  if (config.authMode === 'static') {
    return createStaticTokenVerifier({ staticToken: config.staticToken });
  }
  return createRemoteJwksVerifier({
    issuer: config.oidcIssuer,
    audience: config.oidcAudience,
    jwksUrl: config.oidcJwksUrl,
  });
}

function createServer({
  config = loadConfig(),
  logger = console,
  store = createDefaultStore(config),
  basiqClient = createBasiqClient({ apiKey: config.basiqApiKey }),
  verifyToken = createDefaultVerifier(config),
  rateLimit = { windowMs: 60_000, max: 120 },
} = {}) {
  const checkRateLimit = createRateLimiter(rateLimit);
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

        if (req.method === 'GET' && url.pathname === '/readyz') {
          try {
            const readiness = store.healthCheck ? await store.healthCheck() : { ok: true, store: 'unknown' };
            sendJson(res, 200, {
              ok: true,
              service: 'ledgerly-cloud',
              appEnv: config.appEnv,
              store: readiness.store,
            });
          } catch (err) {
            logger.error?.('readiness_failed', scrubSensitive({ message: err.message, code: err.code }));
            sendJson(res, 503, {
              ok: false,
              service: 'ledgerly-cloud',
              appEnv: config.appEnv,
              error: 'not_ready',
            });
          }
          return;
        }

        if (url.pathname.startsWith('/v1/')) {
          const limited = checkRateLimit(req);
          if (limited) {
            sendJson(res, 429, errorBody('rate_limited', 'Too many requests'), {
              'Retry-After': String(limited.retryAfter),
            });
            return;
          }
          if (!req.headers.authorization) {
            sendJson(res, 401, errorBody('unauthorized', 'Missing bearer token'));
            return;
          }
          const { user } = await authenticate(req, { store, verifyToken });

          if (req.method === 'GET' && url.pathname === '/v1/me') {
            const organizations = await store.listOrganizationsForUser(user.id);
            const firstOrg = organizations[0];
            if (firstOrg) {
              await store.addAuditEvent({
                organizationId: firstOrg.id,
                userId: user.id,
                eventType: 'auth.session_checked',
                metadata: {},
              });
            }
            sendJson(res, 200, {
              user,
              organizations,
            });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/v1/organizations') {
            sendJson(res, 200, {
              organizations: await store.listOrganizationsForUser(user.id),
            });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/v1/organizations') {
            const body = await readJson(req);
            const created = await store.createOrganization({ userId: user.id, name: body.name });
            sendJson(res, 201, created);
            return;
          }

          if (req.method === 'POST' && url.pathname === '/v1/bank-feeds/connect/start') {
            const body = await readJson(req);
            const organizationId = body.organizationId;
            await requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const providerUser = await ensureBasiqUser({
              store,
              basiqClient,
              organizationId,
              email: body.email || user.email,
              mobile: body.mobile || '',
            });
            const consent = await basiqClient.createConsentUrl({
              userId: providerUser.providerUserId,
              action: 'connect',
            });
            const connection = await store.upsertBankFeedConnection({
              organizationId,
              provider: 'basiq',
              providerUserId: providerUser.providerUserId,
              consentStatus: 'pending',
            });
            await store.addAuditEvent({
              organizationId,
              userId: user.id,
              eventType: 'bank_feed.consent_started',
              metadata: { provider: 'basiq' },
            });
            sendJson(res, 201, {
              provider: 'basiq',
              connection,
              consentUrl: consent.url,
            });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/v1/bank-feeds/status') {
            const organizationId = url.searchParams.get('organizationId');
            await requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            sendJson(res, 200, {
              provider: 'basiq',
              configured: true,
              connections: await store.listBankFeedConnections({ organizationId, provider: 'basiq' }),
              accountLinks: await store.listBankFeedAccounts({ organizationId }),
              syncRuns: await store.listBankFeedSyncRuns({ organizationId }),
            });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/v1/bank-feeds/provider-accounts') {
            const organizationId = url.searchParams.get('organizationId');
            await requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const providerUser = await store.getBankProviderUser({ organizationId, provider: 'basiq' });
            if (!providerUser) {
              sendJson(res, 404, errorBody('not_found', 'Bank provider user not found'));
              return;
            }
            sendJson(res, 200, {
              accounts: await basiqClient.listAccounts({ userId: providerUser.providerUserId }),
            });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/v1/bank-feeds/account-links') {
            const body = await readJson(req);
            const organizationId = body.organizationId;
            await requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const connection = body.connectionId
              ? await store.bankFeedConnectionById({ organizationId, connectionId: body.connectionId })
              : await connectionOrError(store, organizationId);
            if (!connection) {
              sendJson(res, 404, errorBody('not_found', 'Bank feed connection not found'));
              return;
            }
            const existed = await store.bankFeedAccountByProvider({
              organizationId,
              providerAccountId: body.providerAccountId,
            });
            const account = await store.upsertBankFeedAccount({
              connectionId: connection.id,
              providerAccountId: body.providerAccountId,
              providerAccountName: body.providerAccountName || '',
              providerAccountNumber: body.providerAccountNumber || '',
              providerAccountType: body.providerAccountType || '',
              desktopBankAccountLocalId: body.desktopBankAccountLocalId || '',
              syncCursor: body.syncCursor || '',
            });
            await store.addAuditEvent({
              organizationId,
              userId: user.id,
              eventType: 'bank_feed.account_mapped',
              metadata: {
                provider: 'basiq',
                providerAccountId: account.providerAccountId,
                desktopBankAccountLocalId: account.desktopBankAccountLocalId,
              },
            });
            sendJson(res, existed ? 200 : 201, { provider: 'basiq', account });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/v1/bank-feeds/sync') {
            const body = await readJson(req);
            const organizationId = body.organizationId;
            await requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const { account, connection } = await accountOrError(store, organizationId, body.providerAccountId);
            consentActiveOrError(connection);
            const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey || '';
            const started = await store.startBankFeedSyncRun({
              organizationId,
              bankFeedAccountId: account.id,
              idempotencyKey,
            });
            if (started.replayed) {
              const result = started.syncRun.result || {
                provider: 'basiq',
                account,
                transactions: [],
              };
              sendJson(res, 200, {
                ...result,
                syncRun: started.syncRun,
                replayed: true,
              });
              return;
            }
            try {
              const listed = await basiqClient.listTransactions({
                userId: connection.providerUserId,
                providerAccountId: account.providerAccountId,
                syncCursor: account.syncCursor || '',
              });
              // Clients return { transactions, nextCursor }; plain arrays are
              // accepted for fakes/backwards compatibility (no cursor advance).
              const transactions = Array.isArray(listed) ? listed : listed.transactions || [];
              const nextCursor = Array.isArray(listed) ? '' : listed.nextCursor || '';
              const result = {
                provider: 'basiq',
                account,
                transactions,
              };
              const syncRun = await store.finishBankFeedSyncRun({
                syncRunId: started.syncRun.id,
                status: 'succeeded',
                importedCount: transactions.length,
                skippedCount: 0,
                result,
                syncCursor: nextCursor,
              });
              await store.addAuditEvent({
                organizationId,
                userId: user.id,
                eventType: 'bank_feed.sync_succeeded',
                metadata: {
                  provider: 'basiq',
                  providerAccountId: account.providerAccountId,
                  transactionCount: transactions.length,
                },
              });
              sendJson(res, 200, {
                ...result,
                syncRun,
              });
              return;
            } catch (err) {
              await store.finishBankFeedSyncRun({
                syncRunId: started.syncRun.id,
                status: 'failed',
                errorMessage: err.message,
              });
              await store.addAuditEvent({
                organizationId,
                userId: user.id,
                eventType: 'bank_feed.sync_failed',
                metadata: {
                  provider: 'basiq',
                  providerAccountId: account.providerAccountId,
                  errorCode: err.code || 'sync_failed',
                },
              });
              throw err;
            }
          }

          if (req.method === 'POST' && url.pathname === '/v1/bank-feeds/data-deletion/request') {
            const body = await readJson(req);
            const organizationId = body.organizationId;
            await requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            await store.addAuditEvent({
              organizationId,
              userId: user.id,
              eventType: 'bank_feed.data_deletion_requested',
              metadata: {
                provider: 'basiq',
                providerAccountId: body.providerAccountId || '',
                reason: body.reason || 'user_requested',
              },
            });
            sendJson(res, 202, { ok: true });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/v1/bank-feeds/consent/manage') {
            const body = await readJson(req);
            const organizationId = body.organizationId;
            await requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const connection = await connectionOrError(store, organizationId);
            const consent = await basiqClient.createConsentUrl({ userId: connection.providerUserId, action: 'manage' });
            await store.addAuditEvent({
              organizationId,
              userId: user.id,
              eventType: 'bank_feed.consent_manage_started',
              metadata: { provider: 'basiq' },
            });
            sendJson(res, 200, { provider: 'basiq', consentUrl: consent.url });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/v1/bank-feeds/consent/reconnect') {
            const body = await readJson(req);
            const organizationId = body.organizationId;
            await requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const connection = await connectionOrError(store, organizationId);
            const consent = await basiqClient.createConsentUrl({ userId: connection.providerUserId, action: 'reconnect' });
            await store.addAuditEvent({
              organizationId,
              userId: user.id,
              eventType: 'bank_feed.consent_reconnect_started',
              metadata: { provider: 'basiq' },
            });
            sendJson(res, 200, { provider: 'basiq', consentUrl: consent.url });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/v1/bank-feeds/consent/revoke') {
            const body = await readJson(req);
            const organizationId = body.organizationId;
            await requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            await basiqClient.revokeConnection({ providerConnectionId: body.providerConnectionId || '' });
            await store.revokeBankFeedConnection({ organizationId, providerConnectionId: body.providerConnectionId || '' });
            await store.addAuditEvent({
              organizationId,
              userId: user.id,
              eventType: 'bank_feed.consent_revoked',
              metadata: { provider: 'basiq' },
            });
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/v1/audit-events') {
            sendJson(res, 200, { events: await store.listAuditEventsForUser(user.id) });
            return;
          }

          const registerMatch = /^\/v1\/organizations\/([^/]+)\/devices\/register$/.exec(url.pathname);
          if (req.method === 'POST' && registerMatch) {
            const organizationId = decodeURIComponent(registerMatch[1]);
            await requireMembership(store, user.id, organizationId, 'devices.manage');
            const body = await readJson(req);
            const device = await store.registerDevice({
              userId: user.id,
              organizationId,
              deviceName: body.deviceName,
              publicKey: body.publicKey,
            });
            await store.addAuditEvent({
              organizationId,
              userId: user.id,
              deviceId: device.id,
              eventType: 'device.registered',
              metadata: { deviceName: device.deviceName },
            });
            sendJson(res, 201, {
              device,
            });
            return;
          }

          const revokeMatch = /^\/v1\/organizations\/([^/]+)\/devices\/([^/]+)\/revoke$/.exec(url.pathname);
          if (req.method === 'POST' && revokeMatch) {
            const organizationId = decodeURIComponent(revokeMatch[1]);
            const deviceId = decodeURIComponent(revokeMatch[2]);
            await requireMembership(store, user.id, organizationId, 'devices.manage');
            sendJson(res, 200, {
              device: await store.revokeDevice({ userId: user.id, organizationId, deviceId }),
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
        if (/Invalid bearer token|Unsupported token algorithm|Unknown token signing key|Invalid token signature|Invalid token issuer|Invalid token audience|Token expired|Token not active|OIDC|Auth verifier/i.test(err.message)) {
          sendJson(res, 401, errorBody('unauthorized', err.message));
          return;
        }
        if (err.status === 403) {
          sendJson(res, 403, errorBody(err.code || 'forbidden', err.message));
          return;
        }
        if (err.status) {
          sendJson(res, err.status, errorBody(err.code || 'request_failed', err.message));
          return;
        }
        if (/required|Invalid JSON body/.test(err.message)) {
          sendJson(res, 400, errorBody('bad_request', err.message));
          return;
        }
        logger.error?.('request_failed', scrubSensitive({ message: err.message, code: err.code }));
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
