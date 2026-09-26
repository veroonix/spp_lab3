const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
const logStream = fs.createWriteStream(config.logFile, { flags: 'a', mode: 0o600 });

logStream.on('error', (error) => {
  process.stderr.write(`Failed to write log file: ${error.message}\n`);
});

function write(level, event, details = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
  };
  const line = `${JSON.stringify(record)}\n`;
  const consoleLine = config.prettyLogs
    ? `${record.timestamp} ${level.toUpperCase().padEnd(5)} ${event} ${Object.entries(details)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' ')}\n`
    : line;

  process.stdout.write(consoleLine);
  logStream.write(line);
}

module.exports = {
  info: (event, details) => write('info', event, details),
  warn: (event, details) => write('warn', event, details),
  error: (event, details) => write('error', event, details),
};
