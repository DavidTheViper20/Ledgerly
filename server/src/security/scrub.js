'use strict';

const SECRET_PATTERNS = [
  /basiq-[A-Za-z0-9._-]+/gi,
  /server-token-[A-Za-z0-9._-]+/gi,
  /client-token-[A-Za-z0-9._-]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(DATABASE_URL|BASIQ_API_KEY|OIDC_CLIENT_SECRET)=\S+/gi,
];

function scrubSensitive(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return SECRET_PATTERNS
      .reduce((out, pattern) => out.replace(pattern, '[REDACTED]'), value)
      .replace(/(postgres:\/\/[^:\s]+:)[^@\s]+(@)/gi, '$1[REDACTED]$2');
  }
  if (Array.isArray(value)) return value.map(scrubSensitive);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      /secret|token|api[_-]?key|password/i.test(key) ? key : key,
      /secret|token|api[_-]?key|password/i.test(key) ? '[REDACTED]' : scrubSensitive(item),
    ]));
  }
  return value;
}

module.exports = { scrubSensitive };
