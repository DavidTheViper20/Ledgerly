'use strict';

const http = require('node:http');

function waitForLoopbackCallback({ redirectUri, state, timeoutMs = 120_000 } = {}) {
  let url;
  try { url = new URL(redirectUri); } catch { throw new Error('Ledgerly Cloud redirect URI is invalid'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Ledgerly Cloud loopback callback must use localhost');
  }
  const expectedPath = url.pathname || '/';
  const port = Number(url.port || 80);

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch {}
      fn(value);
    };
    const server = http.createServer((req, res) => {
      let callbackUrl;
      try { callbackUrl = new URL(req.url, redirectUri); } catch { callbackUrl = null; }
      if (!callbackUrl || callbackUrl.pathname !== expectedPath) {
        res.writeHead(404).end('Not found');
        return;
      }
      const payload = {
        code: callbackUrl.searchParams.get('code') || '',
        state: callbackUrl.searchParams.get('state') || '',
        error: callbackUrl.searchParams.get('error') || '',
        errorDescription: callbackUrl.searchParams.get('error_description') || '',
      };
      const ok = payload.state && payload.state === state && (payload.code || payload.error);
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Ledgerly</title><p>You can return to Ledgerly.</p>');
      if (!ok) {
        done(reject, new Error('Ledgerly Cloud sign-in callback was invalid'));
        return;
      }
      done(resolve, payload);
    });
    const timer = setTimeout(() => {
      done(reject, new Error('Ledgerly Cloud sign-in timed out'));
    }, timeoutMs);
    server.on('error', (err) => done(reject, err));
    server.listen(port, url.hostname);
  });
}

module.exports = { waitForLoopbackCallback };
