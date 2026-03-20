const { authMiddleware, optionalAuthMiddleware } = require('../auth');

/**
 * Middleware to protect routes - requires valid JWT
 */
const requireAuth = authMiddleware;

/**
 * Middleware for optional authentication
 * Doesn't fail if no token, but attaches user if valid
 */
const optionalAuth = optionalAuthMiddleware;

module.exports = {
  requireAuth,
  optionalAuth
};
