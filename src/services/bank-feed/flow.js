'use strict';

const connections = require('./connections');
const basiq = require('./basiq');

function configured(broker) {
  return broker && (!broker.publicStatus || broker.publicStatus().configured);
}

function firstBasiqConnection(db) {
  return connections.listConnections(db).find(c => c.provider === 'basiq' && c.provider_user_id);
}

function connectionUserId(db, userId) {
  if (userId) return userId;
  const connection = firstBasiqConnection(db);
  if (!connection) throw new Error('Connect a bank account first');
  return connection.provider_user_id;
}

function status(db, { broker } = {}) {
  const brokerStatus = broker && broker.publicStatus ? broker.publicStatus() : { configured: false };
  return {
    provider: 'basiq',
    configured: Boolean(brokerStatus.configured),
    connections: connections.listConnections(db),
    accountLinks: connections.listAccountLinks(db),
  };
}

async function startConnect(db, {
  broker,
  email = '',
  mobile = '',
  action = 'connect',
  openExternal,
} = {}) {
  if (!configured(broker)) throw new Error('Basiq broker is not configured');
  let connection = firstBasiqConnection(db);
  let userId = connection && connection.provider_user_id;
  if (!userId) {
    const user = await broker.createUser({ email, mobile });
    userId = user.id;
  }
  const consent = await broker.createConsentUrl({ userId, action });
  if (openExternal) await openExternal(consent.url);
  connection = connections.upsertConnection(db, {
    provider: 'basiq',
    providerUserId: userId,
    providerConnectionId: connection ? connection.provider_connection_id : '',
    institutionName: connection ? connection.institution_name : '',
    status: 'consent_started',
    consentStatus: 'pending',
  });
  return {
    provider: 'basiq',
    action,
    opened: Boolean(openExternal),
    connection,
  };
}

async function listProviderAccounts(db, { broker, userId } = {}) {
  if (!configured(broker)) throw new Error('Basiq broker is not configured');
  return broker.listAccounts({ userId: connectionUserId(db, userId) });
}

function mapProviderAccount(db, args = {}) {
  return connections.mapAccount(db, args);
}

async function syncLinkedAccount(db, {
  broker,
  linkId,
  bankAccountId,
  syncTransactions = basiq.syncTransactions,
} = {}) {
  if (!configured(broker)) throw new Error('Basiq broker is not configured');
  const links = connections.listAccountLinks(db);
  const link = linkId
    ? links.find(l => l.id === Number(linkId))
    : links.find(l => l.bank_account_id === Number(bankAccountId));
  if (!link) throw new Error('Linked bank feed account not found');
  const serverToken = await broker.getServerToken();
  const result = await syncTransactions(db, {
    serverToken,
    userId: link.provider_user_id,
    providerAccountId: link.provider_account_id,
    bankAccountId: link.bank_account_id,
  });
  connections.markAccountLinkSynced(db, {
    linkId: link.id,
    connectionId: link.connection_id,
  });
  return result;
}

async function manageConsent(db, { broker, openExternal, action = 'manage' } = {}) {
  if (!configured(broker)) throw new Error('Basiq broker is not configured');
  const userId = connectionUserId(db);
  const consent = await broker.createConsentUrl({ userId, action });
  if (openExternal) await openExternal(consent.url);
  return {
    provider: 'basiq',
    action,
    opened: Boolean(openExternal),
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
