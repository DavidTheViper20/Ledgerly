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
  saveSession,
  getSession,
  publicStatus,
  signOut,
};
