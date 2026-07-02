'use strict';

const { Pool } = require('pg');

function asIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function last4(value) {
  return String(value || '').replace(/\D/g, '').slice(-4);
}

function publicUser(row) {
  return {
    id: row.id,
    identityProvider: row.identity_provider,
    identitySubject: row.identity_subject,
    email: row.email,
    name: row.name,
  };
}

function publicOrganization(row, role) {
  return {
    id: row.id,
    name: row.name,
    role,
  };
}

function publicDevice(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    deviceName: row.device_name,
    publicKey: row.public_key,
    lastSeenAt: asIso(row.last_seen_at),
    revokedAt: asIso(row.revoked_at),
  };
}

function publicBankProviderUser(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
  };
}

function publicBankConnection(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    providerConnectionId: row.provider_connection_id,
    institutionName: row.institution_name,
    consentStatus: row.consent_status,
    consentExpiresAt: asIso(row.consent_expires_at),
    lastSyncAt: asIso(row.last_sync_at),
    revokedAt: asIso(row.revoked_at),
  };
}

function publicBankFeedAccount(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    providerAccountName: row.provider_account_name,
    providerAccountNumberLast4: row.provider_account_number_last4,
    providerAccountType: row.provider_account_type,
    desktopBankAccountLocalId: row.desktop_bank_account_local_id,
    syncCursor: row.sync_cursor,
    lastSyncAt: asIso(row.account_last_sync_at || row.last_sync_at),
  };
}

function publicSyncRun(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    bankFeedAccountId: row.bank_feed_account_id,
    status: row.status,
    importedCount: row.imported_count,
    skippedCount: row.skipped_count,
    errorMessage: row.error_message,
    idempotencyKey: row.idempotency_key,
    startedAt: asIso(row.started_at),
    finishedAt: asIso(row.finished_at),
    result: row.result_json || null,
  };
}

function publicAuditEvent(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    eventType: row.event_type,
    metadata: row.metadata_json || {},
    createdAt: asIso(row.created_at),
  };
}

function createPool({ databaseUrl, ssl } = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL store');
  return new Pool({
    connectionString: databaseUrl,
    ...(ssl ? { ssl } : {}),
  });
}

function createPostgresStore({ databaseUrl, pool = createPool({ databaseUrl }) } = {}) {
  async function query(sql, params = []) {
    return pool.query(sql, params);
  }

  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function upsertUserFromClaims(claims) {
    if (!claims.sub) throw new Error('Token subject is required');
    const email = claims.email || '';
    const name = claims.name || claims.email || '';
    const result = await query(
      `INSERT INTO users (identity_provider, identity_subject, email, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (identity_subject)
       DO UPDATE SET
         email = COALESCE(NULLIF(EXCLUDED.email, ''), users.email),
         name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name)
       RETURNING *`,
      [claims.iss || '', claims.sub, email, name],
    );
    return publicUser(result.rows[0]);
  }

  async function listOrganizationsForUser(userId) {
    const result = await query(
      `SELECT o.*, m.role
         FROM organization_memberships m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1
        ORDER BY o.created_at ASC`,
      [userId],
    );
    return result.rows.map(row => publicOrganization(row, row.role));
  }

  async function createOrganization({ userId, name }) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Organization name is required');
    return withTransaction(async (client) => {
      const orgResult = await client.query(
        `INSERT INTO organizations (name)
         VALUES ($1)
         RETURNING *`,
        [cleanName],
      );
      const org = orgResult.rows[0];
      const membershipResult = await client.query(
        `INSERT INTO organization_memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'owner')
         RETURNING role`,
        [org.id, userId],
      );
      return {
        organization: publicOrganization(org, membershipResult.rows[0].role),
        membership: { role: membershipResult.rows[0].role },
      };
    });
  }

  async function membershipFor(userId, organizationId) {
    const result = await query(
      `SELECT role
         FROM organization_memberships
        WHERE user_id = $1 AND organization_id = $2`,
      [userId, organizationId],
    );
    return result.rows[0] || null;
  }

  async function setMembershipRole({ userId, organizationId, role }) {
    const result = await query(
      `UPDATE organization_memberships
          SET role = $3
        WHERE user_id = $1 AND organization_id = $2
        RETURNING role`,
      [userId, organizationId, role],
    );
    if (!result.rows[0]) throw new Error('Organization membership required');
    return { role: result.rows[0].role };
  }

  async function organizationFor(userId, organizationId) {
    const result = await query(
      `SELECT o.*, m.role
         FROM organization_memberships m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.organization_id = $2`,
      [userId, organizationId],
    );
    return result.rows[0] ? publicOrganization(result.rows[0], result.rows[0].role) : null;
  }

  async function registerDevice({ userId, organizationId, deviceName, publicKey }) {
    if (!await organizationFor(userId, organizationId)) throw new Error('Organization membership required');
    const result = await query(
      `INSERT INTO devices (user_id, organization_id, device_name, public_key, last_seen_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING *`,
      [userId, organizationId, String(deviceName || '').trim(), String(publicKey || '').trim()],
    );
    return publicDevice(result.rows[0]);
  }

  async function revokeDevice({ userId, organizationId, deviceId }) {
    if (!await organizationFor(userId, organizationId)) throw new Error('Organization membership required');
    const result = await query(
      `UPDATE devices
          SET revoked_at = now()
        WHERE id = $1 AND organization_id = $2
        RETURNING *`,
      [deviceId, organizationId],
    );
    if (!result.rows[0]) throw new Error('Device not found');
    return publicDevice(result.rows[0]);
  }

  async function getBankProviderUser({ organizationId, provider }) {
    const result = await query(
      `SELECT *
         FROM bank_provider_users
        WHERE organization_id = $1 AND provider = $2`,
      [organizationId, provider],
    );
    return result.rows[0] ? publicBankProviderUser(result.rows[0]) : null;
  }

  async function upsertBankProviderUser({ organizationId, provider, providerUserId }) {
    const result = await query(
      `INSERT INTO bank_provider_users (organization_id, provider, provider_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, provider)
       DO UPDATE SET provider_user_id = EXCLUDED.provider_user_id
       RETURNING *`,
      [organizationId, provider, providerUserId],
    );
    return publicBankProviderUser(result.rows[0]);
  }

  async function upsertBankFeedConnection({
    organizationId,
    provider = 'basiq',
    providerUserId,
    providerConnectionId = '',
    institutionName = '',
    consentStatus = 'pending',
    consentExpiresAt = null,
    revokedAt = null,
  }) {
    const result = await query(
      `INSERT INTO bank_feed_connections (
         organization_id, provider, provider_user_id, provider_connection_id,
         institution_name, consent_status, consent_expires_at, revoked_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (organization_id, provider, provider_user_id, provider_connection_id)
       DO UPDATE SET
         institution_name = COALESCE(NULLIF(EXCLUDED.institution_name, ''), bank_feed_connections.institution_name),
         consent_status = COALESCE(NULLIF(EXCLUDED.consent_status, ''), bank_feed_connections.consent_status),
         consent_expires_at = COALESCE(EXCLUDED.consent_expires_at, bank_feed_connections.consent_expires_at),
         revoked_at = EXCLUDED.revoked_at,
         updated_at = now()
       RETURNING *`,
      [
        organizationId,
        provider,
        providerUserId,
        providerConnectionId,
        institutionName,
        consentStatus,
        consentExpiresAt,
        revokedAt,
      ],
    );
    return publicBankConnection(result.rows[0]);
  }

  async function listBankFeedConnections({ organizationId, provider = 'basiq' }) {
    const result = await query(
      `SELECT *
         FROM bank_feed_connections
        WHERE organization_id = $1 AND provider = $2
        ORDER BY created_at ASC`,
      [organizationId, provider],
    );
    return result.rows.map(publicBankConnection);
  }

  async function bankFeedConnectionById({ organizationId, connectionId }) {
    const result = await query(
      `SELECT *
         FROM bank_feed_connections
        WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL`,
      [connectionId, organizationId],
    );
    return result.rows[0] ? publicBankConnection(result.rows[0]) : null;
  }

  async function firstBankFeedConnection({ organizationId, provider = 'basiq' }) {
    const result = await query(
      `SELECT *
         FROM bank_feed_connections
        WHERE organization_id = $1 AND provider = $2 AND revoked_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1`,
      [organizationId, provider],
    );
    return result.rows[0] ? publicBankConnection(result.rows[0]) : null;
  }

  async function revokeBankFeedConnection({ organizationId, providerConnectionId }) {
    const result = await query(
      `UPDATE bank_feed_connections
          SET revoked_at = now(),
              consent_status = 'revoked',
              updated_at = now()
        WHERE organization_id = $1 AND provider_connection_id = $2
        RETURNING *`,
      [organizationId, providerConnectionId],
    );
    return result.rows[0] ? publicBankConnection(result.rows[0]) : null;
  }

  async function upsertBankFeedAccount({
    connectionId,
    providerAccountId,
    providerAccountName = '',
    providerAccountNumber = '',
    providerAccountNumberLast4 = '',
    providerAccountType = '',
    desktopBankAccountLocalId = '',
    syncCursor = '',
  }) {
    if (!providerAccountId) throw new Error('Provider account ID is required');
    const cleanLast4 = last4(providerAccountNumberLast4 || providerAccountNumber);
    const result = await query(
      `WITH active_connection AS (
         SELECT *
           FROM bank_feed_connections
          WHERE id = $1 AND revoked_at IS NULL
       )
       INSERT INTO bank_feed_accounts (
         connection_id, provider_account_id, provider_account_name,
         provider_account_number_last4, provider_account_type,
         desktop_bank_account_local_id, sync_cursor
       )
       SELECT id, $2, $3, $4, $5, $6, $7
         FROM active_connection
       ON CONFLICT (connection_id, provider_account_id)
       DO UPDATE SET
         provider_account_name = COALESCE(NULLIF(EXCLUDED.provider_account_name, ''), bank_feed_accounts.provider_account_name),
         provider_account_number_last4 = COALESCE(NULLIF(EXCLUDED.provider_account_number_last4, ''), bank_feed_accounts.provider_account_number_last4),
         provider_account_type = COALESCE(NULLIF(EXCLUDED.provider_account_type, ''), bank_feed_accounts.provider_account_type),
         desktop_bank_account_local_id = COALESCE(NULLIF(EXCLUDED.desktop_bank_account_local_id, ''), bank_feed_accounts.desktop_bank_account_local_id),
         sync_cursor = COALESCE(NULLIF(EXCLUDED.sync_cursor, ''), bank_feed_accounts.sync_cursor),
         updated_at = now()
       RETURNING *`,
      [
        connectionId,
        providerAccountId,
        providerAccountName,
        cleanLast4,
        providerAccountType,
        String(desktopBankAccountLocalId || ''),
        syncCursor,
      ],
    );
    if (!result.rows[0]) throw new Error('Bank feed connection not found');
    const accountResult = await query(
      `SELECT a.*, c.organization_id, c.provider
         FROM bank_feed_accounts a
         JOIN bank_feed_connections c ON c.id = a.connection_id
        WHERE a.id = $1`,
      [result.rows[0].id],
    );
    return publicBankFeedAccount(accountResult.rows[0]);
  }

  async function listBankFeedAccounts({ organizationId, connectionId } = {}) {
    const params = [];
    const clauses = [];
    if (organizationId) {
      params.push(organizationId);
      clauses.push(`c.organization_id = $${params.length}`);
    }
    if (connectionId) {
      params.push(connectionId);
      clauses.push(`a.connection_id = $${params.length}`);
    }
    const result = await query(
      `SELECT a.*, c.organization_id, c.provider
         FROM bank_feed_accounts a
         JOIN bank_feed_connections c ON c.id = a.connection_id
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY a.created_at ASC`,
      params,
    );
    return result.rows.map(publicBankFeedAccount);
  }

  async function bankFeedAccountByProvider({ organizationId, providerAccountId }) {
    const result = await query(
      `SELECT a.*, c.organization_id, c.provider, c.provider_user_id,
              c.provider_connection_id, c.institution_name, c.consent_status,
              c.consent_expires_at, c.last_sync_at, c.revoked_at
         FROM bank_feed_accounts a
         JOIN bank_feed_connections c ON c.id = a.connection_id
        WHERE c.organization_id = $1 AND a.provider_account_id = $2
        ORDER BY a.created_at ASC
        LIMIT 1`,
      [organizationId, providerAccountId],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      account: publicBankFeedAccount(row),
      connection: publicBankConnection(row),
    };
  }

  async function startBankFeedSyncRun({ organizationId, bankFeedAccountId, idempotencyKey = '' }) {
    if (idempotencyKey) {
      const existing = await query(
        `SELECT *
           FROM bank_feed_sync_runs
          WHERE organization_id = $1 AND idempotency_key = $2
          LIMIT 1`,
        [organizationId, idempotencyKey],
      );
      if (existing.rows[0]) {
        return {
          syncRun: publicSyncRun(existing.rows[0]),
          replayed: true,
        };
      }
    }
    try {
      const result = await query(
        `INSERT INTO bank_feed_sync_runs (
           organization_id, bank_feed_account_id, status, idempotency_key
         )
         VALUES ($1, $2, 'running', $3)
         RETURNING *`,
        [organizationId, bankFeedAccountId, idempotencyKey],
      );
      return { syncRun: publicSyncRun(result.rows[0]), replayed: false };
    } catch (err) {
      if (err.code !== '23505' || !idempotencyKey) throw err;
      const replay = await query(
        `SELECT *
           FROM bank_feed_sync_runs
          WHERE organization_id = $1 AND idempotency_key = $2
          LIMIT 1`,
        [organizationId, idempotencyKey],
      );
      return { syncRun: publicSyncRun(replay.rows[0]), replayed: true };
    }
  }

  async function finishBankFeedSyncRun({
    syncRunId,
    status,
    importedCount = 0,
    skippedCount = 0,
    errorMessage = '',
    result = null,
    syncCursor = '',
  }) {
    return withTransaction(async (client) => {
      const syncResult = await client.query(
        `UPDATE bank_feed_sync_runs
            SET status = $2,
                imported_count = $3,
                skipped_count = $4,
                error_message = $5,
                result_json = $6,
                finished_at = now()
          WHERE id = $1
          RETURNING *`,
        [syncRunId, status, importedCount, skippedCount, errorMessage, result],
      );
      const row = syncResult.rows[0];
      if (!row) throw new Error('Bank feed sync run not found');
      if (status === 'succeeded') {
        await client.query(
          `UPDATE bank_feed_accounts
              SET last_sync_at = $2,
                  sync_cursor = COALESCE(NULLIF($3, ''), sync_cursor),
                  updated_at = now()
            WHERE id = $1`,
          [row.bank_feed_account_id, row.finished_at, syncCursor],
        );
        await client.query(
          `UPDATE bank_feed_connections c
              SET last_sync_at = $2,
                  updated_at = now()
             FROM bank_feed_accounts a
            WHERE a.id = $1 AND c.id = a.connection_id`,
          [row.bank_feed_account_id, row.finished_at],
        );
      }
      return publicSyncRun(row);
    });
  }

  async function listBankFeedSyncRuns({ organizationId } = {}) {
    const result = await query(
      `SELECT *
         FROM bank_feed_sync_runs
        ${organizationId ? 'WHERE organization_id = $1' : ''}
        ORDER BY started_at ASC`,
      organizationId ? [organizationId] : [],
    );
    return result.rows.map(publicSyncRun);
  }

  async function addAuditEvent({ organizationId, userId, deviceId = null, eventType, metadata = {} }) {
    const result = await query(
      `INSERT INTO audit_events (organization_id, user_id, device_id, event_type, metadata_json)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [organizationId || null, userId || null, deviceId || null, eventType, metadata],
    );
    return publicAuditEvent(result.rows[0]);
  }

  async function listAuditEventsForUser(userId) {
    const result = await query(
      `SELECT e.*
         FROM audit_events e
         JOIN organization_memberships m ON m.organization_id = e.organization_id
        WHERE m.user_id = $1
        ORDER BY e.created_at ASC`,
      [userId],
    );
    return result.rows.map(publicAuditEvent);
  }

  async function close() {
    await pool.end();
  }

  async function healthCheck() {
    await query('SELECT 1');
    return { ok: true, store: 'postgres' };
  }

  return {
    healthCheck,
    upsertUserFromClaims,
    listOrganizationsForUser,
    createOrganization,
    membershipFor,
    setMembershipRole,
    organizationFor,
    registerDevice,
    revokeDevice,
    getBankProviderUser,
    upsertBankProviderUser,
    upsertBankFeedConnection,
    listBankFeedConnections,
    bankFeedConnectionById,
    firstBankFeedConnection,
    revokeBankFeedConnection,
    upsertBankFeedAccount,
    listBankFeedAccounts,
    bankFeedAccountByProvider,
    startBankFeedSyncRun,
    finishBankFeedSyncRun,
    listBankFeedSyncRuns,
    addAuditEvent,
    listAuditEventsForUser,
    close,
  };
}

module.exports = {
  createPostgresStore,
};
