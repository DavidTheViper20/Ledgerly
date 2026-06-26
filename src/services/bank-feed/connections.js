'use strict';

function connectionRow(db, id) {
  const row = db.prepare('SELECT * FROM bank_feed_connections WHERE id = ?').get(id);
  if (!row) throw new Error('Bank feed connection not found');
  return row;
}

function linkRow(db, id) {
  const row = db.prepare(`SELECT l.*, c.institution_name, a.name AS bank_account_name
    FROM bank_feed_account_links l
    JOIN bank_feed_connections c ON c.id = l.connection_id
    JOIN accounts a ON a.id = l.bank_account_id
    WHERE l.id = ?`).get(id);
  if (!row) throw new Error('Bank feed account link not found');
  return row;
}

function listConnections(db) {
  const rows = db.prepare('SELECT * FROM bank_feed_connections ORDER BY updated_at DESC, id DESC').all();
  const links = listAccountLinks(db);
  for (const row of rows) row.account_links = links.filter(l => l.connection_id === row.id);
  return rows;
}

function listAccountLinks(db) {
  return db.prepare(`SELECT l.*, c.provider_user_id, c.provider_connection_id,
      c.institution_name, c.status AS connection_status,
      c.consent_status, c.consent_expires_at, a.name AS bank_account_name
    FROM bank_feed_account_links l
    JOIN bank_feed_connections c ON c.id = l.connection_id
    JOIN accounts a ON a.id = l.bank_account_id
    ORDER BY c.institution_name COLLATE NOCASE, l.provider_account_name COLLATE NOCASE`).all();
}

function upsertConnection(db, data = {}) {
  const provider = data.provider || 'basiq';
  const providerUserId = data.providerUserId || data.provider_user_id || '';
  const providerConnectionId = data.providerConnectionId || data.provider_connection_id || '';
  const existing = db.prepare(`SELECT id FROM bank_feed_connections
    WHERE provider = ? AND provider_user_id = ? AND provider_connection_id = ?`)
    .get(provider, providerUserId, providerConnectionId);
  const cols = {
    provider,
    provider_user_id: providerUserId,
    provider_connection_id: providerConnectionId,
    institution_name: data.institutionName || data.institution_name || '',
    status: data.status || 'pending',
    consent_status: data.consentStatus || data.consent_status || 'unknown',
    consent_expires_at: data.consentExpiresAt || data.consent_expires_at || null,
    last_sync_at: data.lastSyncAt || data.last_sync_at || null,
    last_error: data.lastError || data.last_error || '',
  };
  if (existing) {
    db.prepare(`UPDATE bank_feed_connections SET
      institution_name = ?, status = ?, consent_status = ?, consent_expires_at = ?,
      last_sync_at = ?, last_error = ?, updated_at = datetime('now')
      WHERE id = ?`).run(
      cols.institution_name,
      cols.status,
      cols.consent_status,
      cols.consent_expires_at,
      cols.last_sync_at,
      cols.last_error,
      existing.id,
    );
    return connectionRow(db, existing.id);
  }
  const r = db.prepare(`INSERT INTO bank_feed_connections
    (provider, provider_user_id, provider_connection_id, institution_name, status,
     consent_status, consent_expires_at, last_sync_at, last_error)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    cols.provider,
    cols.provider_user_id,
    cols.provider_connection_id,
    cols.institution_name,
    cols.status,
    cols.consent_status,
    cols.consent_expires_at,
    cols.last_sync_at,
    cols.last_error,
  );
  return connectionRow(db, Number(r.lastInsertRowid));
}

function mapAccount(db, data = {}) {
  const connectionId = Number(data.connectionId || data.connection_id);
  if (!connectionId) throw new Error('Bank feed connection is required');
  const connection = connectionRow(db, connectionId);
  const providerAccountId = data.providerAccountId || data.provider_account_id;
  if (!providerAccountId) throw new Error('Provider account ID is required');
  const bankAccountId = Number(data.bankAccountId || data.bank_account_id);
  if (!bankAccountId) throw new Error('Ledgerly bank account is required');
  const bank = db.prepare("SELECT id FROM accounts WHERE id = ? AND type = 'BANK' AND is_archived = 0").get(bankAccountId);
  if (!bank) throw new Error('Ledgerly bank account not found');
  const existing = db.prepare(`SELECT id FROM bank_feed_account_links
    WHERE connection_id = ? AND provider_account_id = ?`).get(connectionId, providerAccountId);
  const cols = {
    provider: data.provider || connection.provider,
    provider_account_name: data.providerAccountName || data.provider_account_name || '',
    provider_account_number: data.providerAccountNumber || data.provider_account_number || '',
    provider_account_type: data.providerAccountType || data.provider_account_type || '',
    bank_account_id: bankAccountId,
    sync_cursor: data.syncCursor || data.sync_cursor || '',
  };
  if (existing) {
    db.prepare(`UPDATE bank_feed_account_links SET
      provider = ?, provider_account_name = ?, provider_account_number = ?,
      provider_account_type = ?, bank_account_id = ?, sync_cursor = ?,
      updated_at = datetime('now')
      WHERE id = ?`).run(
      cols.provider,
      cols.provider_account_name,
      cols.provider_account_number,
      cols.provider_account_type,
      cols.bank_account_id,
      cols.sync_cursor,
      existing.id,
    );
    return linkRow(db, existing.id);
  }
  const r = db.prepare(`INSERT INTO bank_feed_account_links
    (connection_id, provider, provider_account_id, provider_account_name,
     provider_account_number, provider_account_type, bank_account_id, sync_cursor)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    connectionId,
    cols.provider,
    providerAccountId,
    cols.provider_account_name,
    cols.provider_account_number,
    cols.provider_account_type,
    cols.bank_account_id,
    cols.sync_cursor,
  );
  return linkRow(db, Number(r.lastInsertRowid));
}

function disconnectLocalMapping(db, { linkId, id } = {}) {
  const target = Number(linkId || id);
  if (!target) throw new Error('Bank feed account link is required');
  db.prepare('DELETE FROM bank_feed_account_links WHERE id = ?').run(target);
  return { ok: true };
}

function markAccountLinkSynced(db, { linkId, connectionId, syncedAt } = {}) {
  const at = syncedAt || new Date().toISOString();
  db.prepare(`UPDATE bank_feed_account_links
    SET last_sync_at = ?, updated_at = datetime('now')
    WHERE id = ?`).run(at, linkId);
  db.prepare(`UPDATE bank_feed_connections
    SET last_sync_at = ?, last_error = '', updated_at = datetime('now')
    WHERE id = ?`).run(at, connectionId);
  return linkRow(db, linkId);
}

module.exports = {
  listConnections,
  listAccountLinks,
  upsertConnection,
  mapAccount,
  disconnectLocalMapping,
  markAccountLinkSynced,
};
