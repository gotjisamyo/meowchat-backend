const { getDashboardStats, getProducts, getUser } = require('./db');
const { authMiddleware } = require('./auth');
const { requireOwnedShop } = require('./middleware/shopAccess');

function setupRoutes(app) {
  app.get('/api/dashboard', authMiddleware, (req, res) => {
    try {
      const { shopId } = req.query;

      if (!shopId) {
        return res.status(400).json({ success: false, error: 'shopId is required' });
      }

      if (!requireOwnedShop(req, res, shopId)) {
        return;
      }

      const stats = getDashboardStats(req.shopId);
      res.json({ success: true, data: stats });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/catalog/products', authMiddleware, (req, res) => {
    try {
      const { limit, shopId } = req.query;

      if (!shopId) {
        return res.status(400).json({ success: false, error: 'shopId is required' });
      }

      if (!requireOwnedShop(req, res, shopId)) {
        return;
      }

      const products = getProducts({
        shopId: req.shopId,
        limit: limit ? parseInt(limit, 10) : 50
      });
      res.json({ success: true, data: products });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/users/:lineId', authMiddleware, (req, res) => {
    try {
      const user = getUser(req.params.lineId);

      if (!user || String(user.id) !== String(req.userId)) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      res.json({ success: true, data: user });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = { setupRoutes };
