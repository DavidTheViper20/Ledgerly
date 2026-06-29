'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const dbm = require('../src/db');
const session = require('../src/services/cloud/session');
const localLock = require('../src/services/security/local-lock');

let db;
beforeEach(() => { db = dbm.open(':memory:'); });

test('cloud session: sign-out deletes local session tokens without touching org mapping', () => {
  session.saveSession(db, {
    sessionToken: 'ledgerly-session-token',
    refreshToken: 'ledgerly-refresh-token',
    organizationId: 'org_0001',
  });

  assert.equal(session.getSession(db).sessionToken, 'ledgerly-session-token');
  assert.deepEqual(session.publicStatus(db), {
    signedIn: true,
    organizationId: 'org_0001',
  });

  session.signOut(db);

  assert.equal(session.getSession(db).sessionToken, '');
  assert.equal(session.getSession(db).refreshToken, '');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'cloud_session_token'").get(), undefined);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'cloud_refresh_token'").get(), undefined);
  assert.equal(session.publicStatus(db).organizationId, 'org_0001');
});

test('local app lock: stores only salted hashes and verifies passcodes', () => {
  const configured = localLock.configure(db, { enabled: true, passcode: '123456' });

  assert.deepEqual(configured, { enabled: true, configured: true, locked: true });
  assert.equal(localLock.verify(db, { passcode: '123456' }), true);
  assert.equal(localLock.verify(db, { passcode: '000000' }), false);

  const settings = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'app_lock_%'").all();
  assert.doesNotMatch(JSON.stringify(settings), /123456/);
  assert.ok(settings.find(r => r.key === 'app_lock_hash')?.value);
  assert.ok(settings.find(r => r.key === 'app_lock_salt')?.value);

  localLock.configure(db, { enabled: false });
  assert.deepEqual(localLock.status(db), { enabled: false, configured: false, locked: false });
});
