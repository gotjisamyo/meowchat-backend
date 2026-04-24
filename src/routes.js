const { getDashboardStats, getProducts, getUser, getShopsByUserId } = require('./db');
const { authMiddleware } = require('./auth');
const { requireOwnedShop } = require('./middleware/shopAccess');

function setupRoutes(app) {
  app.get('/api/dashboard', authMiddleware, async (req, res) => {
    try {
      let { shopId } = req.query;

      // Auto-resolve shopId from user's first shop if not provided
      if (!shopId) {
        const userShops = await getShopsByUserId(req.userId);
        if (!userShops || userShops.length === 0) {
          return res.status(404).json({ success: false, error: 'ไม่พบร้านค้าของคุณ กรุณาสร้างร้านค้าก่อน' });
        }
        shopId = userShops[0].id;
      }

      if (!await requireOwnedShop(req, res, shopId)) {
        return;
      }

      const stats = await getDashboardStats(req.shopId);
      res.json({ success: true, data: stats });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/catalog/products', authMiddleware, async (req, res) => {
    try {
      const { limit, shopId } = req.query;

      if (!shopId) {
        return res.status(400).json({ success: false, error: 'shopId is required' });
      }

      if (!await requireOwnedShop(req, res, shopId)) {
        return;
      }

      const products = await getProducts({
        shopId: req.shopId,
        limit: limit ? parseInt(limit, 10) : 50
      });
      res.json({ success: true, data: products });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/users/:lineId', authMiddleware, async (req, res, next) => {
    if (req.params.lineId === 'me') return next(); // handled by auth router
    try {
      const user = await getUser(req.params.lineId);

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
