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

test('electron security: cloud-session IPC exposes sign-out but never token getters', () => {
  assert.deepEqual(validateCloudSessionRequest('status', {}), {});
  assert.deepEqual(validateCloudSessionRequest('signOut', {}), {});
  assert.deepEqual(validateCloudSessionRequest('save', {
    sessionToken: 'session-token-1',
    organizationId: 'org_0001',
  }), {
    sessionToken: 'session-token-1',
    organizationId: 'org_0001',
  });
  assert.throws(() => validateCloudSessionRequest('getToken', {}), /Unknown cloud session method/);
  assert.throws(() => validateCloudSessionRequest('save', { basiqApiKey: 'secret' }), /not allowed/i);
});

test('electron security: cloud-auth IPC supports auth commands without token getters', () => {
  assert.deepEqual(validateCloudAuthRequest('status', {}), {});
  assert.deepEqual(validateCloudAuthRequest('signIn', {}), {});
  assert.deepEqual(validateCloudAuthRequest('refresh', {}), {});
  assert.deepEqual(validateCloudAuthRequest('signOut', {}), {});
  assert.throws(() => validateCloudAuthRequest('getToken', {}), /Unknown cloud auth method/);
  assert.throws(() => validateCloudAuthRequest('signIn', { accessToken: 'secret' }), /not allowed/i);
  assert.throws(() => validateCloudAuthRequest('refresh', { refreshToken: 'secret' }), /not allowed/i);
});

test('electron security: external URL validation allows only safe outbound schemes', () => {
  assert.equal(validateExternalUrl('https://ledgerly.example/help'), 'https://ledgerly.example/help');
  assert.equal(validateExternalUrl('mailto:support@ledgerly.example'), 'mailto:support@ledgerly.example');
  assert.throws(() => validateExternalUrl('javascript:alert(1)'), /Unsupported external URL/);
  assert.throws(() => validateExternalUrl('file:///tmp/secret.txt'), /Unsupported external URL/);
});
