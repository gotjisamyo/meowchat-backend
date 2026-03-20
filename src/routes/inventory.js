const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

async function getOwnedProduct(db, userId, productId) {
  return db.get(`
    SELECT p.*
    FROM products p
    JOIN shops s ON s.id = p.shop_id
    WHERE p.id = ? AND s.user_id = ?
  `, [productId, userId]);
}

async function getOwnedAlert(db, userId, alertId) {
  return db.get(`
    SELECT sa.*
    FROM stock_alerts sa
    JOIN shops s ON s.id = sa.shop_id
    WHERE sa.id = ? AND s.user_id = ?
  `, [alertId, userId]);
}

// Get all inventory for a shop
router.get('/:shopId', async (req, res) => {
  const db = getDb();
  const { shopId } = req.params;
  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  const products = await db.all(`
    SELECT
      p.*,
      i.quantity as stock_quantity,
      i.min_stock_level,
      i.location,
      CASE
        WHEN i.quantity <= 0 THEN 'out_of_stock'
        WHEN i.quantity <= i.min_stock_level THEN 'low_stock'
        ELSE 'in_stock'
      END as stock_status
    FROM products p
    LEFT JOIN inventory i ON p.id = i.product_id AND i.shop_id = ?
    WHERE p.shop_id = ?
    ORDER BY p.name
  `, [req.shopId, req.shopId]);

  res.json(products);
});

// Get stock movements
router.get('/:shopId/movements', async (req, res) => {
  const db = getDb();
  const { shopId } = req.params;
  const { productId, limit = 50 } = req.query;

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  let query = `
    SELECT sm.*, p.name as product_name
    FROM stock_movements sm
    JOIN products p ON sm.product_id = p.id
    WHERE sm.shop_id = ?
  `;

  const params = [req.shopId];

  if (productId) {
    const product = await getOwnedProduct(db, req.userId, productId);
    if (!product || product.shop_id !== req.shopId) {
      return res.status(404).json({ error: 'Product not found' });
    }

    query += ' AND sm.product_id = ?';
    params.push(productId);
  }

  query += ' ORDER BY sm.created_at DESC LIMIT ?';
  params.push(parseInt(limit, 10));

  const movements = await db.all(query, params);
  res.json(movements);
});

// Stock In
router.post('/stock-in', async (req, res) => {
  const db = getDb();
  const { shopId, productId, quantity, reference, notes, createdBy } = req.body;

  if (!shopId || !productId || !quantity) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  const product = await getOwnedProduct(db, req.userId, productId);
  if (!product || product.shop_id !== req.shopId) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const movementId = `mov_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  try {
    let inventory = await db.get('SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?',
      [req.shopId, productId]);

    if (inventory) {
      await db.run('UPDATE inventory SET quantity = quantity + ?, updated_at = ? WHERE id = ?',
        [quantity, now, inventory.id]);
    } else {
      const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.run(`
        INSERT INTO inventory (id, shop_id, product_id, quantity, min_stock_level, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 10, 'active', ?, ?)
      `, [invId, req.shopId, productId, quantity, now, now]);
    }

    await db.run(`
      INSERT INTO stock_movements (id, inventory_id, product_id, shop_id, type, quantity, reference, notes, created_by, created_at)
      VALUES (?, (SELECT id FROM inventory WHERE shop_id = ? AND product_id = ?), ?, ?, 'in', ?, ?, ?, ?, ?)
    `, [movementId, req.shopId, productId, productId, req.shopId, quantity, reference, notes, createdBy || String(req.userId), now]);

    const updatedInv = await db.get('SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?',
      [req.shopId, productId]);

    if (updatedInv && updatedInv.quantity <= updatedInv.min_stock_level) {
      const alertId = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.run(`
        INSERT INTO stock_alerts (id, shop_id, product_id, type, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING
      `, [alertId, req.shopId, productId,
        updatedInv.quantity <= 0 ? 'out_of_stock' : 'low_stock', now]);
    }

    res.json({ success: true, movementId });
  } catch (error) {
    console.error('Stock in error:', error);
    res.status(500).json({ error: 'Failed to process stock in' });
  }
});

// Stock Out
router.post('/stock-out', async (req, res) => {
  const db = getDb();
  const { shopId, productId, quantity, reference, notes, createdBy } = req.body;

  if (!shopId || !productId || !quantity) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  const product = await getOwnedProduct(db, req.userId, productId);
  if (!product || product.shop_id !== req.shopId) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const movementId = `mov_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  try {
    let inventory = await db.get('SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?',
      [req.shopId, productId]);

    if (!inventory || inventory.quantity < quantity) {
      return res.status(400).json({
        error: 'Insufficient stock',
        available: inventory ? inventory.quantity : 0
      });
    }

    await db.run('UPDATE inventory SET quantity = quantity - ?, updated_at = ? WHERE id = ?',
      [quantity, now, inventory.id]);

    await db.run(`
      INSERT INTO stock_movements (id, inventory_id, product_id, shop_id, type, quantity, reference, notes, created_by, created_at)
      VALUES (?, (SELECT id FROM inventory WHERE shop_id = ? AND product_id = ?), ?, ?, 'out', ?, ?, ?, ?, ?)
    `, [movementId, req.shopId, productId, productId, req.shopId, quantity, reference, notes, createdBy || String(req.userId), now]);

    const updatedInv = await db.get('SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?',
      [req.shopId, productId]);

    if (updatedInv && updatedInv.quantity <= 0) {
      const alertId = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.run(`
        INSERT INTO stock_alerts (id, shop_id, product_id, type, created_at)
        VALUES (?, ?, ?, 'out_of_stock', ?)
        ON CONFLICT (id) DO NOTHING
      `, [alertId, req.shopId, productId, now]);
    }

    res.json({ success: true, movementId });
  } catch (error) {
    console.error('Stock out error:', error);
    res.status(500).json({ error: 'Failed to process stock out' });
  }
});

// Adjustment
router.post('/adjustment', async (req, res) => {
  const db = getDb();
  const { shopId, productId, adjustment, notes, createdBy } = req.body;

  if (!shopId || !productId || adjustment === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  const product = await getOwnedProduct(db, req.userId, productId);
  if (!product || product.shop_id !== req.shopId) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const movementId = `mov_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  try {
    let inventory = await db.get('SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?',
      [req.shopId, productId]);

    if (inventory) {
      await db.run('UPDATE inventory SET quantity = quantity + ?, updated_at = ? WHERE id = ?',
        [adjustment, now, inventory.id]);
    } else {
      const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await db.run(`
        INSERT INTO inventory (id, shop_id, product_id, quantity, min_stock_level, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 10, 'active', ?, ?)
      `, [invId, req.shopId, productId, adjustment > 0 ? adjustment : 0, now, now]);
    }

    await db.run(`
      INSERT INTO stock_movements (id, inventory_id, product_id, shop_id, type, quantity, reference, notes, created_by, created_at)
      VALUES (?, (SELECT id FROM inventory WHERE shop_id = ? AND product_id = ?), ?, ?, 'adjustment', ?, ?, ?, ?, ?)
    `, [movementId, req.shopId, productId, productId, req.shopId, adjustment, 'Adjustment', notes, createdBy || String(req.userId), now]);

    res.json({ success: true, movementId });
  } catch (error) {
    console.error('Adjustment error:', error);
    res.status(500).json({ error: 'Failed to process adjustment' });
  }
});

// Get alerts
router.get('/:shopId/alerts', async (req, res) => {
  const db = getDb();
  const { shopId } = req.params;
  const { unreadOnly } = req.query;

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  let query = `
    SELECT sa.*, p.name as product_name, p.price
    FROM stock_alerts sa
    JOIN products p ON sa.product_id = p.id
    WHERE sa.shop_id = ?
  `;

  if (unreadOnly === 'true') {
    query += ' AND sa.is_read = 0';
  }

  query += ' ORDER BY sa.created_at DESC';

  const alerts = await db.all(query, [req.shopId]);
  res.json(alerts);
});

// Mark alert as read
router.put('/alerts/:id/read', async (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const alert = await getOwnedAlert(db, req.userId, id);

  if (!alert) {
    return res.status(404).json({ error: 'Alert not found' });
  }

  await db.run('UPDATE stock_alerts SET is_read = 1 WHERE id = ? AND shop_id IN (SELECT id FROM shops WHERE user_id = ?)',
    [id, req.userId]);
  res.json({ success: true });
});

// Get inventory summary
router.get('/:shopId/summary', async (req, res) => {
  const db = getDb();
  const { shopId } = req.params;

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  const summary = await db.get(`
    SELECT
      COUNT(*) as total_products,
      SUM(CASE WHEN i.quantity <= 0 THEN 1 ELSE 0 END) as out_of_stock,
      SUM(CASE WHEN i.quantity > 0 AND i.quantity <= i.min_stock_level THEN 1 ELSE 0 END) as low_stock,
      SUM(COALESCE(i.quantity, 0)) as total_stock,
      SUM(COALESCE(i.quantity, 0) * COALESCE(p.price, 0)) as total_value
    FROM products p
    LEFT JOIN inventory i ON p.id = i.product_id
    WHERE p.shop_id = ?
  `, [req.shopId]);

  res.json(summary);
});

module.exports = router;
