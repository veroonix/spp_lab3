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

const { app, dbReady, db } = require('./server');

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
