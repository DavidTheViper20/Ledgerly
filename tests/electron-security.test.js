'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  contentSecurityPolicy,
  secureBrowserWindowOptions,
  validateBankFeedRequest,
  validateCloudAuthRequest,
  validateCloudSessionRequest,
  validateExternalUrl,
} = require('../electron/security');
const dbm = require('../src/db');
const { createDesktopCloudAuth } = require('../src/services/cloud/auth');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (buffer) => Buffer.from(buffer).toString('utf8').replace(/^encrypted:/, ''),
  };
}

test('electron security: browser defaults are sandboxed and CSP blocks remote code', () => {
  const options = secureBrowserWindowOptions({ preload: '/tmp/preload.js' });
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(options.webPreferences.allowRunningInsecureContent, false);

  const csp = contentSecurityPolicy();
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|https?:/);
});

test('electron security: bank-feed IPC validation rejects unknown methods, bad shapes, and secrets', () => {
  assert.deepEqual(validateBankFeedRequest('syncLinkedAccount', { linkId: '42' }), { linkId: 42 });
  assert.deepEqual(validateBankFeedRequest('manageConsent', { action: 'reconnect' }), { action: 'reconnect' });
  assert.throws(() => validateBankFeedRequest('syncLinkedAccount', { serverToken: 'server-token-1', linkId: 42 }), /not allowed/i);
  assert.throws(() => validateBankFeedRequest('startConnect', { email: 'not-email' }), /email/i);
  assert.throws(() => validateBankFeedRequest('missingMethod', {}), /Unknown bank feed method/);
});

test('electron security: cloud-auth IPC allows exactly status/signIn/refresh/signOut', () => {
  for (const method of ['status', 'signIn', 'refresh', 'signOut']) {
    assert.deepEqual(validateCloudAuthRequest(method, {}), {}, `${method} should return an empty arg set`);
  }
  for (const method of ['getToken', 'save', 'exchange', '']) {
    assert.throws(() => validateCloudAuthRequest(method, {}), /Unknown cloud auth method/);
  }
});

test('electron security: cloud-auth IPC rejects secret-looking args', () => {
  assert.throws(() => validateCloudAuthRequest('signIn', { accessToken: 'secret' }), /not allowed/i);
  assert.throws(() => validateCloudAuthRequest('refresh', { refresh_token: 'secret' }), /not allowed/i);
  assert.throws(() => validateCloudAuthRequest('status', { apiKey: 'secret' }), /not allowed/i);
});

test('electron security: cloud-session IPC allows exactly status/save/signOut', () => {
  assert.deepEqual(validateCloudSessionRequest('status', {}), {});
  assert.deepEqual(validateCloudSessionRequest('signOut', {}), {});
  assert.deepEqual(validateCloudSessionRequest('save', {
    sessionToken: 'session-token-1',
    organizationId: 'org_0001',
  }), {
    sessionToken: 'session-token-1',
    organizationId: 'org_0001',
  });
  for (const method of ['getToken', 'refresh', 'signIn', '']) {
    assert.throws(() => validateCloudSessionRequest(method, {}), /Unknown cloud session method/);
  }
});

test('electron security: cloud-session save requires sessionToken and organizationId', () => {
  assert.throws(() => validateCloudSessionRequest('save', { organizationId: 'org_0001' }), /sessionToken is required/i);
  assert.throws(() => validateCloudSessionRequest('save', { sessionToken: 'session-token-1' }), /organizationId is required/i);
});

test('electron security: cloud-session IPC rejects secret keys outside the allowlist', () => {
  assert.throws(() => validateCloudSessionRequest('save', {
    sessionToken: 'session-token-1',
    organizationId: 'org_0001',
    providerToken: 'secret',
  }), /not allowed/i);
  assert.throws(() => validateCloudSessionRequest('save', { basiqApiKey: 'secret' }), /not allowed/i);
});

test('electron security: desktop cloud auth publicStatus never leaks token material', () => {
  const db = dbm.open(':memory:');
  const auth = createDesktopCloudAuth({
    getDb: () => db,
    config: { configured: true },
    safeStorage: fakeSafeStorage(),
  });
  const status = auth.publicStatus();
  assert.deepEqual(
    Object.keys(status),
    ['configured', 'signedIn', 'email', 'name', 'expiresAt', 'organizationId'],
  );
});

test('electron security: external URL validation allows only safe outbound schemes', () => {
  assert.equal(validateExternalUrl('https://ledgerly.example/help'), 'https://ledgerly.example/help');
  assert.equal(validateExternalUrl('mailto:support@ledgerly.example'), 'mailto:support@ledgerly.example');
  assert.throws(() => validateExternalUrl('javascript:alert(1)'), /Unsupported external URL/);
  assert.throws(() => validateExternalUrl('file:///tmp/secret.txt'), /Unsupported external URL/);
});
