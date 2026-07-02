'use strict';

const http = require('node:http');

// Starts a loopback HTTP listener for the native-app OAuth callback
// (RFC 8252 section 7.3). Resolves once the server is listening with:
//   { redirectUri, callback }
// - redirectUri: the effective callback URL including the bound port. When
//   the configured redirect URI has no port (or port 0), an ephemeral port
//   is bound and injected here; the authorize request must use this value.
// - callback: promise resolving to { code, state, error, errorDescription }
//   when the browser redirects back, or rejecting on timeout/invalid state.
function startLoopbackCallback({ redirectUri, state, timeoutMs = 120_000 } = {}) {
  let url;
  try { url = new URL(redirectUri); } catch { throw new Error('Ledgerly Cloud redirect URI is invalid'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Ledgerly Cloud loopback callback must use localhost');
  }
  const expectedPath = url.pathname || '/';
  const requestedPort = url.port === '' ? 0 : Number(url.port);

  return new Promise((resolveStart, rejectStart) => {
    let started = false;
    let settled = false;
    let timer = null;
    let settleCallback = { resolve: () => {}, reject: () => {} };

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch {}
      fn(value);
    };

    const callback = new Promise((resolve, reject) => {
      settleCallback = { resolve, reject };
    });

    const server = http.createServer((req, res) => {
      let callbackUrl;
      try { callbackUrl = new URL(req.url, `http://${url.hostname}`); } catch { callbackUrl = null; }
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
        done(settleCallback.reject, new Error('Ledgerly Cloud sign-in callback was invalid'));
        return;
      }
      done(settleCallback.resolve, payload);
    });

    server.on('error', (err) => {
      if (!started) {
        if (err.code === 'EADDRINUSE') {
          rejectStart(new Error(
            `Ledgerly Cloud sign-in port ${requestedPort} is already in use. ` +
            'Close the conflicting app, or remove the fixed port from LEDGERLY_AUTH_REDIRECT_URI to use an automatic port.',
          ));
        } else {
          rejectStart(err);
        }
        return;
      }
      done(settleCallback.reject, err);
    });

    server.listen(requestedPort, url.hostname, () => {
      started = true;
      timer = setTimeout(() => {
        done(settleCallback.reject, new Error('Ledgerly Cloud sign-in timed out'));
      }, timeoutMs);
      const effective = new URL(redirectUri);
      effective.port = String(server.address().port);
      resolveStart({ redirectUri: effective.toString(), callback });
    });
  });
}

module.exports = { startLoopbackCallback };
