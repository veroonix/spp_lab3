const { hashToken } = require('./security');

function createAuthMiddleware({ db, dbReady, sendError }) {
  async function authenticate(req, res, next) {
    await dbReady;
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token) return sendError(res, 401, 'AUTH_REQUIRED', 'Требуется авторизация');

    const session = await db.queryOne(
      `SELECT sessions.token_hash, users.id, users.email, users.role
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      [hashToken(token), Date.now()],
    );
    if (!session) return sendError(res, 401, 'TOKEN_INVALID', 'Сессия недействительна или истекла');
    req.user = session;
    return next();
  }

  function requireRole(...allowedRoles) {
    return (req, res, next) => {
      if (!req.user || !allowedRoles.includes(req.user.role)) {
        return sendError(res, 403, 'FORBIDDEN', 'Недостаточно прав для операции');
      }
      return next();
    };
  }

  return { authenticate, requireRole };
}

module.exports = { createAuthMiddleware };
