'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createMemoryStore } = require('../src/db/memory-store');
const { createPostgresStore } = require('../src/db/postgres-store');
const { runMigrations } = require('../src/db/migrate');
const { loadConfig } = require('../src/config');

function testConfig(databaseUrl) {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: databaseUrl,
    OIDC_ISSUER: 'https://issuer.test/',
    OIDC_AUDIENCE: 'ledgerly-api-test',
    BASIQ_API_KEY: 'basiq-secret-key',
    CORS_ORIGINS: 'http://localhost:3000',
    PORT: '0',
  });
}

async function exerciseStore(createStore) {
  const store = await createStore();
  try {
    assert.deepEqual(await store.healthCheck(), { ok: true, store: store.kind || 'memory' });

    const user = await store.upsertUserFromClaims({
      iss: 'https://issuer.test/',
      sub: 'auth0|contract-user',
      email: 'owner@example.com',
      name: 'Owner Example',
    });
    assert.equal(user.identitySubject, 'auth0|contract-user');

    const created = await store.createOrganization({ userId: user.id, name: 'Viper Design Studio' });
    assert.equal(created.organization.name, 'Viper Design Studio');
    assert.equal(created.membership.role, 'owner');

    const organizations = await store.listOrganizationsForUser(user.id);
    assert.deepEqual(organizations, [created.organization]);

    const device = await store.registerDevice({
      userId: user.id,
      organizationId: created.organization.id,
      deviceName: 'David MacBook',
      publicKey: 'device-public-key',
    });
    assert.equal(device.revokedAt, null);

    const providerUser = await store.upsertBankProviderUser({
      organizationId: created.organization.id,
      provider: 'basiq',
      providerUserId: 'basiq-user-1',
    });
    assert.equal(providerUser.providerUserId, 'basiq-user-1');

    const connection = await store.upsertBankFeedConnection({
      organizationId: created.organization.id,
      provider: 'basiq',
      providerUserId: 'basiq-user-1',
      providerConnectionId: 'conn-1',
      institutionName: 'Sandbox Bank',
      consentStatus: 'active',
      consentExpiresAt: '2026-12-31T00:00:00.000Z',
    });
    assert.equal(connection.consentStatus, 'active');

    const account = await store.upsertBankFeedAccount({
      connectionId: connection.id,
      providerAccountId: 'acc-1',
      providerAccountName: 'Business Everyday',
      providerAccountNumber: '123456789',
      providerAccountType: 'transaction',
      desktopBankAccountLocalId: '17',
    });
    assert.equal(account.providerAccountNumberLast4, '6789');
    assert.equal(account.desktopBankAccountLocalId, '17');

    const started = await store.startBankFeedSyncRun({
      organizationId: created.organization.id,
      bankFeedAccountId: account.id,
      idempotencyKey: 'sync-1',
    });
    assert.equal(started.replayed, false);

    const result = { provider: 'basiq', account, transactions: [{ sourceTransactionId: 'tx-1' }] };
    const finished = await store.finishBankFeedSyncRun({
      syncRunId: started.syncRun.id,
      status: 'succeeded',
      importedCount: 1,
      result,
    });
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.importedCount, 1);

    const replayed = await store.startBankFeedSyncRun({
      organizationId: created.organization.id,
      bankFeedAccountId: account.id,
      idempotencyKey: 'sync-1',
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.syncRun.id, started.syncRun.id);
    assert.deepEqual(replayed.syncRun.result, result);

    await store.addAuditEvent({
      organizationId: created.organization.id,
      userId: user.id,
      deviceId: device.id,
      eventType: 'bank_feed.sync_succeeded',
      metadata: { provider: 'basiq' },
    });
    const events = await store.listAuditEventsForUser(user.id);
    assert.equal(events.at(-1).eventType, 'bank_feed.sync_succeeded');
    assert.deepEqual(events.at(-1).metadata, { provider: 'basiq' });

    const revoked = await store.revokeDevice({
      userId: user.id,
      organizationId: created.organization.id,
      deviceId: device.id,
    });
    assert.ok(revoked.revokedAt);
  } finally {
    if (store.close) await store.close();
  }
}

test('store contract: memory implementation supports cloud persistence behavior', async () => {
  await exerciseStore(async () => {
    const store = createMemoryStore({ now: () => '2026-06-30T00:00:00.000Z' });
    store.kind = 'memory';
    return store;
  });
});

test('store contract: postgres implementation supports cloud persistence behavior when configured', { skip: !process.env.LEDGERLY_TEST_DATABASE_URL }, async () => {
  const databaseUrl = process.env.LEDGERLY_TEST_DATABASE_URL;
  await runMigrations({ config: testConfig(databaseUrl) });

  await exerciseStore(async () => {
    const pgStore = createPostgresStore({ databaseUrl });
    pgStore.kind = 'postgres';
    return pgStore;
  });
});
