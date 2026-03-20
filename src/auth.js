const jwt = require('jsonwebtoken');
const { findUserById } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

function generateToken(userId, role = 'user') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

function extractToken(authHeader) {
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  return parts[1];
}

async function attachAuthenticatedUser(req, res, decoded) {
  const user = await findUserById(decoded.userId);

  if (!user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'User no longer exists'
    });
    return false;
  }

  req.userId = user.id;
  req.user = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role || 'user',
    created_at: user.created_at
  };

  return true;
}

async function authMiddleware(req, res, next) {
  const token = extractToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'No token provided'
    });
  }

  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }

  if (!await attachAuthenticatedUser(req, res, decoded)) {
    return;
  }

  next();
}

async function optionalAuthMiddleware(req, res, next) {
  const token = extractToken(req.headers.authorization);

  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      await attachAuthenticatedUser(req, res, decoded);
    }
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role || 'user') !== 'admin') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'เฉพาะ admin เท่านั้น'
    });
  }

  next();
}

module.exports = {
  JWT_SECRET,
  generateToken,
  verifyToken,
  extractToken,
  authMiddleware,
  optionalAuthMiddleware,
  requireAdmin
};
