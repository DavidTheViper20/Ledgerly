'use strict';

const SECRET_KEY_RE = /(api[_-]?key|server[_-]?token|client[_-]?token|provider.*token|basiq.*key|access[_-]?token)/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

function secureBrowserWindowOptions({ preload }) {
  return {
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#f4f5f8',
    title: 'Ledgerly',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };
}

function registerContentSecurityPolicy(electronSession) {
  if (!electronSession?.webRequest?.onHeadersReceived) return;
  electronSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()],
      },
    });
  });
}

function rejectSecretKeys(args = {}, allowed = new Set()) {
  for (const key of Object.keys(args || {})) {
    if (!allowed.has(key) && SECRET_KEY_RE.test(key)) {
      throw new Error(`IPC field is not allowed: ${key}`);
    }
  }
}

function stringValue(value, name, { required = false, max = 512 } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error(`${name} is required`);
    return '';
  }
  const out = String(value).trim();
  if (out.length > max) throw new Error(`${name} is too long`);
  return out;
}

function numberValue(value, name, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  const out = Number(value);
  if (!Number.isInteger(out) || out <= 0) throw new Error(`${name} must be a positive integer`);
  return out;
}

function actionValue(value, fallback = 'manage') {
  const out = stringValue(value, 'action') || fallback;
  if (!['connect', 'manage', 'reconnect'].includes(out)) throw new Error('Unsupported bank feed action');
  return out;
}

function validateBankFeedRequest(method, args = {}) {
  rejectSecretKeys(args);
  switch (method) {
    case 'status':
    case 'listProviderAccounts':
      return {};
    case 'startConnect': {
      const email = stringValue(args.email, 'email', { max: 254 });
      if (email && !EMAIL_RE.test(email)) throw new Error('Invalid email');
      return {
        ...(email ? { email } : {}),
        ...(args.mobile ? { mobile: stringValue(args.mobile, 'mobile', { max: 40 }) } : {}),
        action: actionValue(args.action, 'connect'),
      };
    }
    case 'mapProviderAccount':
      return {
        connectionId: numberValue(args.connectionId, 'connectionId', { required: true }),
        providerAccountId: stringValue(args.providerAccountId, 'providerAccountId', { required: true }),
        providerAccountName: stringValue(args.providerAccountName, 'providerAccountName'),
        providerAccountNumber: stringValue(args.providerAccountNumber, 'providerAccountNumber', { max: 80 }),
        providerAccountType: stringValue(args.providerAccountType, 'providerAccountType', { max: 80 }),
        bankAccountId: numberValue(args.bankAccountId, 'bankAccountId', { required: true }),
      };
    case 'syncLinkedAccount': {
      const out = {};
      const linkId = numberValue(args.linkId, 'linkId');
      const bankAccountId = numberValue(args.bankAccountId, 'bankAccountId');
      if (!linkId && !bankAccountId) throw new Error('linkId or bankAccountId is required');
      if (linkId) out.linkId = linkId;
      if (bankAccountId) out.bankAccountId = bankAccountId;
      if (args.idempotencyKey) out.idempotencyKey = stringValue(args.idempotencyKey, 'idempotencyKey', { max: 128 });
      return out;
    }
    case 'manageConsent':
      return { action: actionValue(args.action, 'manage') };
    case 'revokeConsent':
      return { providerConnectionId: stringValue(args.providerConnectionId, 'providerConnectionId', { max: 128 }) };
    case 'requestDataDeletion':
      return {
        providerAccountId: stringValue(args.providerAccountId, 'providerAccountId', { max: 128 }),
        reason: stringValue(args.reason, 'reason', { max: 80 }) || 'user_requested',
      };
    case 'disconnectLocalMapping':
      return { linkId: numberValue(args.linkId || args.id, 'linkId', { required: true }) };
    case 'fakeSync':
      return {
        bankAccountId: numberValue(args.bankAccountId, 'bankAccountId', { required: true }),
        providerAccountId: stringValue(args.providerAccountId, 'providerAccountId', { required: true }),
      };
    case 'basiqSync':
      throw new Error('Direct Basiq token sync is disabled. Use Connect bank account.');
    default:
      throw new Error('Unknown bank feed method: ' + method);
  }
}

function validateCloudSessionRequest(method, args = {}) {
  rejectSecretKeys(args, new Set(['sessionToken', 'refreshToken']));
  switch (method) {
    case 'status':
    case 'signOut':
      return {};
    case 'save':
      return {
        sessionToken: stringValue(args.sessionToken, 'sessionToken', { required: true, max: 4096 }),
        ...(args.refreshToken ? { refreshToken: stringValue(args.refreshToken, 'refreshToken', { max: 4096 }) } : {}),
        organizationId: stringValue(args.organizationId, 'organizationId', { required: true, max: 128 }),
      };
    default:
      throw new Error('Unknown cloud session method: ' + method);
  }
}

function validateExternalUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('Unsupported external URL'); }
  if (!['https:', 'mailto:'].includes(url.protocol)) throw new Error('Unsupported external URL');
  return url.toString();
}

module.exports = {
  contentSecurityPolicy,
  secureBrowserWindowOptions,
  registerContentSecurityPolicy,
  validateBankFeedRequest,
  validateCloudSessionRequest,
  validateExternalUrl,
};
