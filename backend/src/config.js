const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');

module.exports = {
  rootDir,
  port,
  dataDir,
  uploadDir: path.join(dataDir, 'uploads'),
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionTtlMs: 8 * 60 * 60 * 1000,
  recoveryTtlMs: 30 * 60 * 1000,
  loginLimit: 5,
  loginLockMs: 15 * 60 * 1000,
};
