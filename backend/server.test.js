const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { promisify } = require('node:util');
const request = require('supertest');

const scrypt = promisify(crypto.scrypt);
const dataDir = fs.mkdtempSync(pathJoin(os.tmpdir(), 'library-test-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-password';
process.env.NODE_ENV = 'test';

const { app, dbReady, db, cleanupExpiredRecords } = require('./server');

function pathJoin(...parts) {
  return require('node:path').join(...parts);
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function queryOne(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

async function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}

async function login(email, password) {
  const response = await request(app).post('/api/auth/login').send({ email, password });
  assert.equal(response.status, 200);
  return response.body.token;
}

async function createUser(email, password, role) {
  await run('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)', [
    email,
    await passwordHash(password),
    role,
  ]);
}

test.before(async () => {
  await dbReady;
  await createUser('editor@test.local', 'editor-password', 'editor');
  await createUser('viewer@test.local', 'viewer-password', 'viewer');
});

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('logout-all revokes every session owned by the current user', async () => {
  const firstToken = await login('editor@test.local', 'editor-password');
  const secondToken = await login('editor@test.local', 'editor-password');
  const accessible = await request(app)
    .get('/api/books')
    .set('Authorization', `Bearer ${secondToken}`);
  assert.equal(accessible.status, 200);

  const logoutAll = await request(app)
    .post('/api/auth/logout-all')
    .set('Authorization', `Bearer ${firstToken}`);
  assert.equal(logoutAll.status, 204);

  const revoked = await request(app)
    .get('/api/books')
    .set('Authorization', `Bearer ${secondToken}`);
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.code, 'TOKEN_INVALID');
});

test('admins can list active sessions and revoke another user sessions', async () => {
  const adminToken = await login('admin@test.local', 'admin-password');
  const created = await request(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: 'session-target@test.local', password: 'editor-password', role: 'editor' });
  assert.equal(created.status, 201);

  const firstToken = await login('session-target@test.local', 'editor-password');
  const secondToken = await login('session-target@test.local', 'editor-password');
  const users = await request(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(users.status, 200);
  const target = users.body.find((user) => user.email === 'session-target@test.local');
  assert.equal(target.activeSessionCount, 2);
  assert.equal(Object.hasOwn(target, 'token_hash'), false);

  const revoked = await request(app)
    .delete(`/api/admin/users/${target.id}/sessions`)
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revokedSessions, 2);

  const oldSession = await request(app)
    .get('/api/books')
    .set('Authorization', `Bearer ${secondToken}`);
  assert.equal(oldSession.status, 401);

  const viewerToken = await login('viewer@test.local', 'viewer-password');
  const forbidden = await request(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${viewerToken}`);
  assert.equal(forbidden.status, 403);
  assert.ok(firstToken);
});

test('cleans expired sessions, recovery tokens, and stale login attempts', async () => {
  const user = await queryOne('SELECT id FROM users WHERE email = ?', ['viewer@test.local']);
  const oldTimestamp = Date.now() - 24 * 60 * 60 * 1000;
  const expiredSessionHash = crypto.randomBytes(32).toString('hex');
  const expiredRecoveryHash = crypto.randomBytes(32).toString('hex');
  const usedRecoveryHash = crypto.randomBytes(32).toString('hex');

  await run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [
    expiredSessionHash, user.id, oldTimestamp,
  ]);
  await run('INSERT INTO recovery_tokens (token_hash, user_id, expires_at, used) VALUES (?, ?, ?, 0)', [
    expiredRecoveryHash, user.id, oldTimestamp,
  ]);
  await run('INSERT INTO recovery_tokens (token_hash, user_id, expires_at, used) VALUES (?, ?, ?, 1)', [
    usedRecoveryHash, user.id, Date.now() + 60 * 60 * 1000,
  ]);
  await run(`INSERT INTO login_attempts (email, ip, failed_count, locked_until, last_attempt_at)
    VALUES (?, ?, 2, 0, ?)`, ['stale@test.local', '127.0.0.2', oldTimestamp]);

  const cleaned = await cleanupExpiredRecords();
  assert.ok(cleaned.sessions >= 1);
  assert.ok(cleaned.recoveryTokens >= 2);
  assert.ok(cleaned.loginAttempts >= 1);
  assert.equal(await queryOne('SELECT token_hash FROM sessions WHERE token_hash = ?', [expiredSessionHash]), undefined);
  assert.equal(await queryOne('SELECT token_hash FROM recovery_tokens WHERE token_hash = ?', [expiredRecoveryHash]), undefined);
  assert.equal(await queryOne('SELECT token_hash FROM recovery_tokens WHERE token_hash = ?', [usedRecoveryHash]), undefined);
  assert.equal(await queryOne('SELECT email FROM login_attempts WHERE email = ?', ['stale@test.local']), undefined);
});

test('registers new accounts as viewers and rejects duplicate emails', async () => {
  const registration = await request(app).post('/api/auth/register').send({
    email: 'new-viewer@test.local',
    password: 'viewer-password',
    role: 'admin',
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.body.user.role, 'viewer');
  assert.ok(registration.body.token);

  const deniedWrite = await request(app)
    .post('/api/books')
    .set('Authorization', `Bearer ${registration.body.token}`)
    .field('title', 'Запрещено')
    .field('author', 'Автор')
    .field('year', '2020')
    .field('genre', 'Роман');
  assert.equal(deniedWrite.status, 403);

  const duplicate = await request(app).post('/api/auth/register').send({
    email: 'new-viewer@test.local',
    password: 'another-password',
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'EMAIL_ALREADY_REGISTERED');
});

test('only admins can provision accounts with assigned roles', async () => {
  const anonymous = await request(app).post('/api/admin/users').send({
    email: 'managed-editor@test.local',
    password: 'editor-password',
    role: 'editor',
  });
  assert.equal(anonymous.status, 401);

  const viewerToken = await login('viewer@test.local', 'viewer-password');
  const forbidden = await request(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${viewerToken}`)
    .send({ email: 'managed-editor@test.local', password: 'editor-password', role: 'editor' });
  assert.equal(forbidden.status, 403);

  const adminToken = await login('admin@test.local', 'admin-password');
  const created = await request(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: 'managed-editor@test.local', password: 'editor-password', role: 'editor' });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.role, 'editor');

  const editorLogin = await request(app).post('/api/auth/login').send({
    email: 'managed-editor@test.local',
    password: 'editor-password',
  });
  assert.equal(editorLogin.status, 200);
  assert.equal(editorLogin.body.user.role, 'editor');

  const duplicate = await request(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: 'managed-editor@test.local', password: 'editor-password', role: 'editor' });
  assert.equal(duplicate.status, 409);
});

test('protects books and enforces role permissions', async () => {
  const anonymous = await request(app).get('/api/books');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, 'AUTH_REQUIRED');

  const editorToken = await login('editor@test.local', 'editor-password');
  const created = await request(app)
    .post('/api/books')
    .set('Authorization', `Bearer ${editorToken}`)
    .field('title', 'Тестовая книга')
    .field('author', 'Автор')
    .field('year', '2020')
    .field('genre', 'Роман')
    .field('description', 'Описание');
  assert.equal(created.status, 201);

  const editorDelete = await request(app)
    .delete(`/api/books/${created.body.id}`)
    .set('Authorization', `Bearer ${editorToken}`);
  assert.equal(editorDelete.status, 403);

  const viewerToken = await login('viewer@test.local', 'viewer-password');
  const viewerWrite = await request(app)
    .post('/api/books')
    .set('Authorization', `Bearer ${viewerToken}`)
    .field('title', 'Запрещено')
    .field('author', 'Автор')
    .field('year', '2020')
    .field('genre', 'Роман');
  assert.equal(viewerWrite.status, 403);

  const adminToken = await login('admin@test.local', 'admin-password');
  const deleted = await request(app)
    .delete(`/api/books/${created.body.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(deleted.status, 204);
});

test('removes uploaded cover when book insert fails', async () => {
  const editorToken = await login('editor@test.local', 'editor-password');
  const uploadDir = pathJoin(dataDir, 'uploads');
  const filesBefore = fs.readdirSync(uploadDir).sort();
  await run(`CREATE TRIGGER fail_book_insert BEFORE INSERT ON books
    BEGIN SELECT RAISE(ABORT, 'forced test failure'); END`);

  let response;
  try {
    response = await request(app)
      .post('/api/books')
      .set('Authorization', `Bearer ${editorToken}`)
      .field('title', 'Книга с ошибкой')
      .field('author', 'Автор')
      .field('year', '2020')
      .field('genre', 'Роман')
      .attach('cover', Buffer.from('test image'), { filename: 'cover.png', contentType: 'image/png' });
  } finally {
    await run('DROP TRIGGER fail_book_insert');
  }

  assert.equal(response.status, 500);
  assert.deepEqual(fs.readdirSync(uploadDir).sort(), filesBefore);
});

test('locks repeated credential guesses and supports password recovery', async () => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request(app).post('/api/auth/login').send({
      email: 'admin@test.local',
      password: 'wrong-password',
    });
    assert.equal(response.status, 401);
  }
  const locked = await request(app).post('/api/auth/login').send({
    email: 'admin@test.local',
    password: 'wrong-password',
  });
  assert.equal(locked.status, 429);
  assert.ok(locked.headers['retry-after']);

  const recovery = await request(app).post('/api/auth/recover').send({ email: 'admin@test.local' });
  assert.equal(recovery.status, 202);
  assert.ok(recovery.body.resetToken);

  const reset = await request(app).post('/api/auth/reset').send({
    token: recovery.body.resetToken,
    password: 'new-admin-password',
  });
  assert.equal(reset.status, 204);
  const newToken = await login('admin@test.local', 'new-admin-password');
  assert.ok(newToken);
});

test('returns standard not-found status for unknown API resources', async () => {
  const response = await request(app).get('/api/missing');
  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'API_NOT_FOUND');
});
