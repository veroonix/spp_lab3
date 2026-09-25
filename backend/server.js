const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const { z } = require('zod');
const config = require('./src/config');
const logger = require('./src/logger');
const {
  hashToken,
  hashPassword,
  verifyPassword,
  createToken,
} = require('./src/auth/security');
const { createMailer } = require('./src/auth/email');
const { createAuthMiddleware } = require('./src/auth/middleware');

const { port: PORT, dataDir: DATA_DIR, uploadDir: UPLOAD_DIR, nodeEnv: NODE_ENV } = config;

const ALLOWED_GENRES = [
  'Фантастика',
  'Детектив',
  'Роман',
  'Приключения',
  'Фэнтези',
  'История',
  'Научпоп',
  'Мистика',
  'Классика',
  'Бизнес',
  'Психология',
  'Детская',
];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new sqlite3.Database(path.join(DATA_DIR, 'library.sqlite'));
const dbReady = new Promise((resolve, reject) => {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    year INTEGER NOT NULL,
    genre TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    cover_path TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`, (error) => {
      if (error) reject(error);
    });
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS recovery_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS login_attempts (
      email TEXT NOT NULL,
      ip TEXT NOT NULL,
      failed_count INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (email, ip)
    )`, async (error) => {
      if (error) {
        reject(error);
        return;
      }

      try {
        const adminEmail = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
        const adminPassword = process.env.ADMIN_PASSWORD || 'change-me-now';
        if (NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
          throw new Error('ADMIN_PASSWORD must be configured in production');
        }
        const existing = await queryOne('SELECT id FROM users WHERE email = ?', [adminEmail]);
        if (!existing) {
          await run('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)', [
            adminEmail,
            await hashPassword(adminPassword),
            'admin',
          ]);
          logger.info('admin_seeded', { email: adminEmail, passwordConfigured: Boolean(process.env.ADMIN_PASSWORD) });
        }
        resolve();
      } catch (seedError) {
        reject(seedError);
      }
    });
  });
});

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  const startedAt = Date.now();
  res.setHeader('X-Request-Id', req.requestId);
  res.on('finish', () => logger.info('http_request', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    status: res.statusCode,
    durationMs: Date.now() - startedAt,
    ip: req.ip,
  }));
  next();
});
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const randomPart = Math.random().toString(36).slice(2);
      callback(null, `${Date.now()}-${randomPart}${extension}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      return callback(new Error('Поддерживаются только JPG, PNG и WEBP'));
    }

    return callback(null, true);
  },
});

const bookSchema = z.object({
  title: z.string().trim().min(1).max(120),
  author: z.string().trim().min(1).max(100),
  year: z.coerce.number().int().min(1000).max(new Date().getFullYear()),
  genre: z.string().refine((value) => ALLOWED_GENRES.includes(value)),
  description: z.string().trim().max(1000).default(''),
});

function queryAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
    });
  });
}

function queryOne(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role };
}

function sendError(res, status, code, message) {
  return res.status(status).json({ error: message, code, requestId: res.getHeader('X-Request-Id') });
}
const mailer = createMailer({ logger, port: PORT });
const { authenticate, requireRole } = createAuthMiddleware({
  db: { queryOne },
  dbReady,
  sendError,
});

async function parseBody(schema, req, res) {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    sendError(res, 400, 'VALIDATION_ERROR', validationError(result.error));
    return null;
  }
  return result.data;
}

const credentialsSchema = z.object({
  email: z.string().trim().email().max(160).transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(200),
});
const recoveryRequestSchema = z.object({ email: z.string().trim().email().max(160) });
const resetSchema = z.object({ token: z.string().min(20), password: z.string().min(8).max(200) });

function formatBook(book) {
  if (!book) {
    return book;
  }

  return {
    ...book,
    coverUrl: book.cover_path ? `/uploads/${book.cover_path}` : null,
  };
}

function validationError(error) {
  return error.issues.map((issue) => issue.message).join('. ');
}

app.post('/api/auth/login', async (req, res, next) => {
  try {
    await dbReady;
    const result = credentialsSchema.safeParse(req.body);
    if (!result.success) return sendError(res, 400, 'VALIDATION_ERROR', validationError(result.error));
    const { email, password } = result.data;
    const ip = req.ip;
    const attempt = await queryOne('SELECT * FROM login_attempts WHERE email = ? AND ip = ?', [email, ip]);
    if (attempt?.locked_until > Date.now()) {
      res.setHeader('Retry-After', Math.ceil((attempt.locked_until - Date.now()) / 1000));
      return sendError(res, 429, 'LOGIN_LOCKED', 'Слишком много неудачных попыток. Повторите позже');
    }
    const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
    const valid = user && await verifyPassword(password, user.password_hash);
    if (!valid) {
      const failedCount = (attempt?.failed_count || 0) + 1;
      const lockedUntil = failedCount >= config.loginLimit ? Date.now() + config.loginLockMs : 0;
      await run(`INSERT INTO login_attempts (email, ip, failed_count, locked_until) VALUES (?, ?, ?, ?)
        ON CONFLICT(email, ip) DO UPDATE SET failed_count = excluded.failed_count, locked_until = excluded.locked_until`,
      [email, ip, failedCount, lockedUntil]);
      logger.warn('login_failed', { requestId: req.requestId, email, ip, failedCount });
      if (lockedUntil) res.setHeader('Retry-After', Math.ceil(config.loginLockMs / 1000));
      return sendError(res, lockedUntil ? 429 : 401, lockedUntil ? 'LOGIN_LOCKED' : 'INVALID_CREDENTIALS', 'Неверный email или пароль');
    }
    await run('DELETE FROM login_attempts WHERE email = ? AND ip = ?', [email, ip]);
    const token = createToken();
    await run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [hashToken(token), user.id, Date.now() + config.sessionTtlMs]);
    return res.json({ token, expiresIn: config.sessionTtlMs / 1000, user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/logout', authenticate, async (req, res, next) => {
  try {
    await run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(req.get('authorization').slice(7))]);
    return res.status(204).send();
  } catch (error) { return next(error); }
});

app.post('/api/auth/logout-all', authenticate, async (req, res, next) => {
  try {
    await run('DELETE FROM sessions WHERE user_id = ?', [req.user.id]);
    return res.status(204).send();
  } catch (error) { return next(error); }
});

app.post('/api/auth/recover', async (req, res, next) => {
  try {
    await dbReady;
    const result = recoveryRequestSchema.safeParse(req.body);
    if (!result.success) return sendError(res, 400, 'VALIDATION_ERROR', validationError(result.error));
    const user = await queryOne('SELECT * FROM users WHERE email = ?', [result.data.email.toLowerCase()]);
    const response = { message: 'Если аккаунт существует, инструкции отправлены на email' };
    if (user) {
      const token = createToken();
      await run('INSERT INTO recovery_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [hashToken(token), user.id, Date.now() + config.recoveryTtlMs]);
      const resetUrl = mailer.recoveryUrl(token);
      logger.info('password_recovery_requested', { requestId: req.requestId, email: user.email, resetUrl: NODE_ENV === 'production' ? undefined : resetUrl });
      await mailer.sendRecoveryEmail(user.email, resetUrl);
      if (NODE_ENV !== 'production') response.resetToken = token;
    }
    return res.status(202).json(response);
  } catch (error) { return next(error); }
});

app.post('/api/auth/reset', async (req, res, next) => {
  try {
    await dbReady;
    const result = resetSchema.safeParse(req.body);
    if (!result.success) return sendError(res, 400, 'VALIDATION_ERROR', validationError(result.error));
    const recovery = await queryOne('SELECT * FROM recovery_tokens WHERE token_hash = ? AND used = 0 AND expires_at > ?', [hashToken(result.data.token), Date.now()]);
    if (!recovery) return sendError(res, 400, 'RESET_TOKEN_INVALID', 'Токен восстановления недействителен или истек');
    await run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(result.data.password), recovery.user_id]);
    await run('UPDATE recovery_tokens SET used = 1 WHERE token_hash = ?', [recovery.token_hash]);
    await run('DELETE FROM sessions WHERE user_id = ?', [recovery.user_id]);
    await run('DELETE FROM login_attempts WHERE email = (SELECT email FROM users WHERE id = ?)', [recovery.user_id]);
    return res.status(204).send();
  } catch (error) { return next(error); }
});

app.get('/api/books', authenticate, async (_req, res, next) => {
  try {
    const books = await queryAll('SELECT * FROM books ORDER BY created_at DESC, id DESC');
    return res.json(books.map(formatBook));
  } catch (error) { return next(error); }
});

app.get('/api/books/:id', authenticate, async (req, res, next) => {
  try {
    const book = await queryOne('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!book) return sendError(res, 404, 'BOOK_NOT_FOUND', 'Книга не найдена');
    return res.json(formatBook(book));
  } catch (error) { return next(error); }
});

app.post('/api/books', authenticate, requireRole('admin', 'editor'), upload.single('cover'), async (req, res, next) => {
  try {
    const data = await parseBody(bookSchema, req, res);
    if (!data) return;
    const coverPath = req.file ? req.file.filename : null;
    const result = await run(`INSERT INTO books (title, author, year, genre, description, cover_path)
      VALUES (?, ?, ?, ?, ?, ?)`, [data.title, data.author, data.year, data.genre, data.description, coverPath]);
    const book = await queryOne('SELECT * FROM books WHERE id = ?', [result.id]);
    return res.status(201).json(formatBook(book));
  } catch (error) { return next(error); }
});

app.put('/api/books/:id', authenticate, requireRole('admin', 'editor'), upload.single('cover'), async (req, res, next) => {
  try {
    const current = await queryOne('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!current) {
      if (req.file) fs.rmSync(req.file.path, { force: true });
      return sendError(res, 404, 'BOOK_NOT_FOUND', 'Книга не найдена');
    }
    const data = await parseBody(bookSchema, req, res);
    if (!data) return;
    const coverPath = req.file ? req.file.filename : current.cover_path;
    await run(`UPDATE books SET title = ?, author = ?, year = ?, genre = ?, description = ?, cover_path = ? WHERE id = ?`,
      [data.title, data.author, data.year, data.genre, data.description, coverPath, req.params.id]);
    if (req.file && current.cover_path) fs.rmSync(path.join(UPLOAD_DIR, current.cover_path), { force: true });
    const updatedBook = await queryOne('SELECT * FROM books WHERE id = ?', [req.params.id]);
    return res.json(formatBook(updatedBook));
  } catch (error) { return next(error); }
});

app.delete('/api/books/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const book = await queryOne('SELECT * FROM books WHERE id = ?', [req.params.id]);

    if (!book) {
      return sendError(res, 404, 'BOOK_NOT_FOUND', 'Книга не найдена');
    }

    await run('DELETE FROM books WHERE id = ?', [req.params.id]);

    if (book.cover_path) {
      fs.rmSync(path.join(UPLOAD_DIR, book.cover_path), { force: true });
    }

    return res.status(204).send();
  } catch (error) {
    return next(error);
  }
});

app.get('/api/health', async (_req, res, next) => {
  try {
    await dbReady;
    return res.json({ status: 'ok' });
  } catch (error) {
    return next(error);
  }
});

app.use('/api', (_req, res) => {
  sendError(res, 404, 'API_NOT_FOUND', 'API-ресурс не найден');
});

app.use((error, _req, res, _next) => {
  if (
    error instanceof multer.MulterError ||
    error.message === 'File too large' ||
    error.message === 'Поддерживаются только JPG, PNG и WEBP'
  ) {
    const message =
      error.message === 'Поддерживаются только JPG, PNG и WEBP'
        ? error.message
        : 'Файл должен быть изображением до 5 МБ';

    return sendError(res, 400, 'UPLOAD_INVALID', message);
  }

  logger.error('unhandled_error', { requestId: res.getHeader('X-Request-Id'), message: error.message, stack: error.stack });
  return sendError(res, 500, 'INTERNAL_ERROR', 'Внутренняя ошибка сервера');
});

async function startServer() {
  await dbReady;
  return app.listen(PORT, () => logger.info('server_started', { port: PORT, environment: NODE_ENV }));
}

if (require.main === module) {
  startServer().catch((error) => {
    logger.error('startup_failed', { message: error.message, stack: error.stack });
    process.exitCode = 1;
  });
}

module.exports = { app, db, dbReady, startServer };