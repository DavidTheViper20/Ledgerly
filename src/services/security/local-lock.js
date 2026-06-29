'use strict';

const crypto = require('node:crypto');

const ITERATIONS = 120_000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

function setting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value || ''));
}

function deleteSetting(db, key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

function hashPasscode(passcode, salt) {
  return crypto.pbkdf2Sync(String(passcode), salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('base64');
}

function status(db) {
  const enabled = setting(db, 'app_lock_enabled') === '1';
  const configured = Boolean(setting(db, 'app_lock_hash') && setting(db, 'app_lock_salt'));
  return { enabled, configured, locked: enabled && configured };
}

function configure(db, { enabled, passcode = '' } = {}) {
  if (!enabled) {
    deleteSetting(db, 'app_lock_enabled');
    deleteSetting(db, 'app_lock_hash');
    deleteSetting(db, 'app_lock_salt');
    return status(db);
  }
  if (!/^\d{6,}$/.test(String(passcode))) throw new Error('App lock passcode must be at least 6 digits');
  const salt = crypto.randomBytes(16).toString('base64');
  setSetting(db, 'app_lock_enabled', '1');
  setSetting(db, 'app_lock_salt', salt);
  setSetting(db, 'app_lock_hash', hashPasscode(passcode, salt));
  return status(db);
}

function verify(db, { passcode = '' } = {}) {
  const salt = setting(db, 'app_lock_salt');
  const expected = setting(db, 'app_lock_hash');
  if (!salt || !expected) return false;
  const actual = hashPasscode(passcode, salt);
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

module.exports = {
  status,
  configure,
  verify,
};
