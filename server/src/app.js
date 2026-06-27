'use strict';

const http = require('node:http');

const { loadConfig } = require('./config');

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function createServer({ config = loadConfig(), logger = console } = {}) {
  return http.createServer((req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          service: 'ledgerly-cloud',
          appEnv: config.appEnv,
        });
        return;
      }

      sendJson(res, 404, {
        error: {
          code: 'not_found',
          message: 'Route not found',
        },
      });
    } catch (err) {
      logger.error?.('request_failed', { message: err.message });
      sendJson(res, 500, {
        error: {
          code: 'internal_error',
          message: 'Internal server error',
        },
      });
    }
  });
}

if (require.main === module) {
  const config = loadConfig();
  const server = createServer({ config });
  server.listen(config.port, () => {
    console.log(`Ledgerly Cloud listening on ${config.port}`);
  });
}

module.exports = {
  createServer,
};
