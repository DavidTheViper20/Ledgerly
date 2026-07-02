'use strict';

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

// Legacy dev-only path: plaintext session tokens in SQLite settings.
// Production builds must sign in through the PKCE flow (services/cloud/auth.js),
// which keeps access tokens in main-process memory and refresh tokens in
// safeStorage. This gate decides whether the legacy path is honoured at all.
function legacyTokenAllowed({ isPackaged = false, env = process.env } = {}) {
  if (isPackaged) return false;
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') return false;
  if (String(env.APP_ENV || '').toLowerCase() === 'production') return false;
  return true;
}

function saveSession(db, { sessionToken, refreshToken = '', organizationId } = {}) {
  if (!sessionToken) throw new Error('Cloud session token is required');
  if (!organizationId) throw new Error('Cloud organization is required');
  setSetting(db, 'cloud_session_token', sessionToken);
  if (refreshToken) setSetting(db, 'cloud_refresh_token', refreshToken);
  setSetting(db, 'cloud_organization_id', organizationId);
  return publicStatus(db);
}

function getSession(db) {
  return {
    sessionToken: setting(db, 'cloud_session_token'),
    refreshToken: setting(db, 'cloud_refresh_token'),
    organizationId: setting(db, 'cloud_organization_id'),
  };
}

function publicStatus(db) {
  const current = getSession(db);
  return {
    signedIn: Boolean(current.sessionToken),
    organizationId: current.organizationId,
  };
}

function signOut(db) {
  deleteSetting(db, 'cloud_session_token');
  deleteSetting(db, 'cloud_refresh_token');
  return publicStatus(db);
}

module.exports = {
  legacyTokenAllowed,
  saveSession,
  getSession,
  publicStatus,
  signOut,
};
