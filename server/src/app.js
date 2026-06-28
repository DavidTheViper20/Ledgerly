'use strict';

const http = require('node:http');

const { loadConfig } = require('./config');
const { createRemoteJwksVerifier, verifyBearerAuth } = require('./auth/verify-token');
const { can } = require('./auth/roles');
const { createMemoryStore } = require('./db/memory-store');
const { createBasiqClient } = require('./providers/basiq-client');

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

async function ensureBasiqUser({ store, basiqClient, organizationId, email, mobile }) {
  const existing = store.getBankProviderUser({ organizationId, provider: 'basiq' });
  if (existing) return existing;
  const user = await basiqClient.createUser({ email, mobile });
  return store.upsertBankProviderUser({
    organizationId,
    provider: 'basiq',
    providerUserId: user.id,
  });
}

function connectionOrError(store, organizationId) {
  const connection = store.firstBankFeedConnection({ organizationId, provider: 'basiq' });
  if (!connection) {
    const err = new Error('Bank feed connection not found');
    err.status = 404;
    err.code = 'not_found';
    throw err;
  }
  return connection;
}

function accountOrError(store, organizationId, providerAccountId) {
  const found = store.bankFeedAccountByProvider({ organizationId, providerAccountId });
  if (!found) {
    const err = new Error('Bank feed account link not found');
    err.status = 404;
    err.code = 'not_found';
    throw err;
  }
  return found;
}

function createServer({
  config = loadConfig(),
  logger = console,
  store = createMemoryStore(),
  basiqClient = createBasiqClient({ apiKey: config.basiqApiKey }),
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

          if (req.method === 'POST' && url.pathname === '/v1/bank-feeds/connect/start') {
            const body = await readJson(req);
            const organizationId = body.organizationId;
            requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
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
            const connection = store.upsertBankFeedConnection({
              organizationId,
              provider: 'basiq',
              providerUserId: providerUser.providerUserId,
              consentStatus: 'pending',
            });
            store.addAuditEvent({
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
            requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            sendJson(res, 200, {
              provider: 'basiq',
              configured: true,
              connections: store.listBankFeedConnections({ organizationId, provider: 'basiq' }),
              accountLinks: store.listBankFeedAccounts({ organizationId }),
              syncRuns: store.listBankFeedSyncRuns({ organizationId }),
            });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/v1/bank-feeds/provider-accounts') {
            const organizationId = url.searchParams.get('organizationId');
            requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const providerUser = store.getBankProviderUser({ organizationId, provider: 'basiq' });
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
            requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const connection = body.connectionId
              ? store.bankFeedConnectionById({ organizationId, connectionId: body.connectionId })
              : connectionOrError(store, organizationId);
            if (!connection) {
              sendJson(res, 404, errorBody('not_found', 'Bank feed connection not found'));
              return;
            }
            const existed = store.bankFeedAccountByProvider({
              organizationId,
              providerAccountId: body.providerAccountId,
            });
            const account = store.upsertBankFeedAccount({
              connectionId: connection.id,
              providerAccountId: body.providerAccountId,
              providerAccountName: body.providerAccountName || '',
              providerAccountNumber: body.providerAccountNumber || '',
              providerAccountType: body.providerAccountType || '',
              desktopBankAccountLocalId: body.desktopBankAccountLocalId || '',
              syncCursor: body.syncCursor || '',
            });
            store.addAuditEvent({
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
            requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const { account, connection } = accountOrError(store, organizationId, body.providerAccountId);
            const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey || '';
            const started = store.startBankFeedSyncRun({
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
              const transactions = await basiqClient.listTransactions({
                userId: connection.providerUserId,
                providerAccountId: account.providerAccountId,
                syncCursor: account.syncCursor || '',
              });
              const result = {
                provider: 'basiq',
                account,
                transactions,
              };
              const syncRun = store.finishBankFeedSyncRun({
                syncRunId: started.syncRun.id,
                status: 'succeeded',
                importedCount: transactions.length,
                skippedCount: 0,
                result,
              });
              store.addAuditEvent({
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
              store.finishBankFeedSyncRun({
                syncRunId: started.syncRun.id,
                status: 'failed',
                errorMessage: err.message,
              });
              store.addAuditEvent({
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

          if (req.method === 'POST' && url.pathname === '/v1/bank-feeds/consent/manage') {
            const body = await readJson(req);
            const organizationId = body.organizationId;
            requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const connection = connectionOrError(store, organizationId);
            const consent = await basiqClient.createConsentUrl({ userId: connection.providerUserId, action: 'manage' });
            store.addAuditEvent({
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
            requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            const connection = connectionOrError(store, organizationId);
            const consent = await basiqClient.createConsentUrl({ userId: connection.providerUserId, action: 'reconnect' });
            store.addAuditEvent({
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
            requireMembership(store, user.id, organizationId, 'bank_feeds.manage');
            await basiqClient.revokeConnection({ providerConnectionId: body.providerConnectionId || '' });
            store.revokeBankFeedConnection({ organizationId, providerConnectionId: body.providerConnectionId || '' });
            store.addAuditEvent({
              organizationId,
              userId: user.id,
              eventType: 'bank_feed.consent_revoked',
              metadata: { provider: 'basiq' },
            });
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/v1/audit-events') {
            sendJson(res, 200, { events: store.listAuditEventsForUser(user.id) });
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
        if (err.status) {
          sendJson(res, err.status, errorBody(err.code || 'request_failed', err.message));
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
