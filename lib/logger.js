// lib/logger.js
const { randomUUID } = require('crypto');

const PRETTY = process.env.LOG_PRETTY === '1';

function ts() {
  return new Date().toISOString();
}

function base(level, msg, extra) {
  const rec = { t: ts(), level, msg, ...extra };
  if (PRETTY) {
    // Human-friendly single line
    const { t, level, msg, ...rest } = rec;
    const restStr = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    // e.g. 2025-08-10T12:34:56.789Z INFO server started {"port":3000}
    console.log(`${t} ${level.toUpperCase()} ${msg}${restStr}`);
  } else {
    // Strict JSON
    console.log(JSON.stringify(rec));
  }
}

const logger = {
  info: (msg, extra = {}) => base('info', msg, extra),
  warn: (msg, extra = {}) => base('warn', msg, extra),
  error: (msg, extra = {}) => base('error', msg, extra),
  debug: (msg, extra = {}) => {
    if (process.env.LOG_LEVEL === 'debug') base('debug', msg, extra);
  },
  // tiny helper to seed a request id
  newReqId: () => randomUUID()
};

module.exports = logger;
