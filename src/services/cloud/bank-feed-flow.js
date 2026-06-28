'use strict';

const connections = require('../bank-feed/connections');
const { importProviderTransactions } = require('../bank-feed/importer');

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function configured(cloudClient) {
  return cloudClient && (!cloudClient.publicStatus || cloudClient.publicStatus().configured);
}

function requireConfigured(cloudClient) {
  if (!configured(cloudClient)) {
    throw new Error('Ledgerly Cloud bank feeds are not configured');
  }
}

function localConnectionData(connection = {}) {
  return {
    provider: connection.provider || 'basiq',
    providerUserId: connection.providerUserId || connection.provider_user_id || '',
    providerConnectionId: connection.providerConnectionId || connection.provider_connection_id || '',
    institutionName: connection.institutionName || connection.institution_name || '',
    status: connection.status || (connection.consentStatus === 'active' ? 'connected' : 'consent_started'),
    consentStatus: connection.consentStatus || connection.consent_status || 'pending',
    consentExpiresAt: connection.consentExpiresAt || connection.consent_expires_at || null,
  };
}

function scrubConsentUrl(result) {
  if (!result) return result;
  const copy = { ...result };
  delete copy.consentUrl;
  return copy;
}

function findLink(db, { linkId, bankAccountId } = {}) {
  const links = connections.listAccountLinks(db);
  const link = linkId
    ? links.find(l => l.id === Number(linkId))
    : links.find(l => l.bank_account_id === Number(bankAccountId));
  if (!link) throw new Error('Linked bank feed account not found');
  return link;
}

async function status(db, { cloudClient, organizationId } = {}) {
  const publicStatus = cloudClient?.publicStatus ? cloudClient.publicStatus() : { configured: false };
  const cloudReady = Boolean(publicStatus.configured && (organizationId || publicStatus.organizationConfigured));
  const out = {
    provider: 'basiq',
    configured: cloudReady,
    cloudConfigured: Boolean(publicStatus.configured),
    setupRequired: publicStatus.configured && !cloudReady ? 'organization' : '',
    mode: 'cloud',
    connections: connections.listConnections(db),
    accountLinks: connections.listAccountLinks(db),
  };
  if (cloudReady && cloudClient.status) {
    out.cloud = await cloudClient.status({ organizationId });
  }
  return out;
}

async function startConnect(db, {
  cloudClient,
  organizationId,
  email = '',
  mobile = '',
  action = 'connect',
  openExternal,
} = {}) {
  requireConfigured(cloudClient);
  const result = await cloudClient.startConnect(compact({ organizationId, email, mobile, action }));
  if (openExternal && result.consentUrl) await openExternal(result.consentUrl);
  const connection = connections.upsertConnection(db, localConnectionData(result.connection || { provider: result.provider }));
  return {
    ...scrubConsentUrl(result),
    action,
    opened: Boolean(openExternal && result.consentUrl),
    connection,
  };
}

async function listProviderAccounts(db, { cloudClient, organizationId } = {}) {
  requireConfigured(cloudClient);
  const result = await cloudClient.listProviderAccounts(compact({ organizationId }));
  return result.accounts || result;
}

async function mapProviderAccount(db, args = {}) {
  const { cloudClient, organizationId } = args;
  requireConfigured(cloudClient);
  const localLinkInput = {
    connectionId: args.connectionId || args.connection_id,
    providerAccountId: args.providerAccountId || args.provider_account_id,
    providerAccountName: args.providerAccountName || args.provider_account_name,
    providerAccountNumber: args.providerAccountNumber || args.provider_account_number,
    providerAccountType: args.providerAccountType || args.provider_account_type,
    bankAccountId: args.bankAccountId || args.bank_account_id,
    syncCursor: args.syncCursor || args.sync_cursor,
  };
  await cloudClient.mapProviderAccount(compact({
    organizationId,
    providerAccountId: localLinkInput.providerAccountId,
    providerAccountName: localLinkInput.providerAccountName,
    providerAccountNumber: localLinkInput.providerAccountNumber,
    providerAccountType: localLinkInput.providerAccountType,
    desktopBankAccountLocalId: String(localLinkInput.bankAccountId),
    syncCursor: localLinkInput.syncCursor,
  }));
  return connections.mapAccount(db, localLinkInput);
}

async function syncLinkedAccount(db, {
  cloudClient,
  organizationId,
  linkId,
  bankAccountId,
  idempotencyKey,
} = {}) {
  requireConfigured(cloudClient);
  const link = findLink(db, { linkId, bankAccountId });
  const result = await cloudClient.syncLinkedAccount(compact({
    organizationId,
    providerAccountId: link.provider_account_id,
    desktopBankAccountLocalId: String(link.bank_account_id),
    idempotencyKey,
  }));
  const imported = importProviderTransactions(db, {
    provider: result.provider || link.provider,
    bankAccountId: link.bank_account_id,
    transactions: result.transactions || [],
  });
  connections.markAccountLinkSynced(db, {
    linkId: link.id,
    connectionId: link.connection_id,
    syncedAt: result.syncRun?.finishedAt,
  });
  return {
    ...imported,
    provider: result.provider || link.provider,
    syncRun: result.syncRun,
    replayed: Boolean(result.replayed),
  };
}

async function manageConsent(db, { cloudClient, organizationId, openExternal, action = 'manage' } = {}) {
  requireConfigured(cloudClient);
  const result = await cloudClient.manageConsent(compact({ organizationId, action }));
  if (openExternal && result.consentUrl) await openExternal(result.consentUrl);
  return {
    ...scrubConsentUrl(result),
    action,
    opened: Boolean(openExternal && result.consentUrl),
  };
}

module.exports = {
  status,
  startConnect,
  listProviderAccounts,
  mapProviderAccount,
  syncLinkedAccount,
  manageConsent,
};
