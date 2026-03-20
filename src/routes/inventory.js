const express = require('express');
const router = express.Router();
const Database = require('better-sqlite3');
const path = require('path');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

const dbPath = path.join(__dirname, '../../data/database.sqlite');
const db = new Database(dbPath);

router.use(authMiddleware);

function getOwnedProduct(productId, userId) {
  return db.prepare(`
    SELECT p.*
    FROM products p
    JOIN shops s ON s.id = p.shop_id
    WHERE p.id = ? AND s.user_id = ?
  `).get(productId, userId);
}

function getOwnedAlert(alertId, userId) {
  return db.prepare(`
    SELECT sa.*
    FROM stock_alerts sa
    JOIN shops s ON s.id = sa.shop_id
    WHERE sa.id = ? AND s.user_id = ?
  `).get(alertId, userId);
}

// Get all inventory for a shop
router.get('/:shopId', (req, res) => {
  const { shopId } = req.params;
  if (!requireOwnedShop(req, res, shopId)) {
    return;
  }

  const products = db.prepare(`
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
  `).all(req.shopId, req.shopId);

  res.json(products);
});

// Get stock movements
router.get('/:shopId/movements', (req, res) => {
  const { shopId } = req.params;
  const { productId, limit = 50 } = req.query;

  if (!requireOwnedShop(req, res, shopId)) {
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
    const product = getOwnedProduct(productId, req.userId);
    if (!product || product.shop_id !== req.shopId) {
      return res.status(404).json({ error: 'Product not found' });
    }

    query += ' AND sm.product_id = ?';
    params.push(productId);
  }

  query += ' ORDER BY sm.created_at DESC LIMIT ?';
  params.push(parseInt(limit, 10));

  const movements = db.prepare(query).all(...params);
  res.json(movements);
});

// Stock In
router.post('/stock-in', (req, res) => {
  const { shopId, productId, quantity, reference, notes, createdBy } = req.body;

  if (!shopId || !productId || !quantity) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!requireOwnedShop(req, res, shopId)) {
    return;
  }

  const product = getOwnedProduct(productId, req.userId);
  if (!product || product.shop_id !== req.shopId) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const movementId = `mov_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  try {
    let inventory = db.prepare('SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?')
      .get(req.shopId, productId);

    if (inventory) {
      db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = ? WHERE id = ?')
        .run(quantity, now, inventory.id);
    } else {
      const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      db.prepare(`
        INSERT INTO inventory (id, shop_id, product_id, quantity, min_stock_level, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 10, 'active', ?, ?)
      `).run(invId, req.shopId, productId, quantity, now, now);
    }

    db.prepare(`
      INSERT INTO stock_movements (id, inventory_id, product_id, shop_id, type, quantity, reference, notes, created_by, created_at)
      VALUES (?, (SELECT id FROM inventory WHERE shop_id = ? AND product_id = ?), ?, ?, 'in', ?, ?, ?, ?, ?)
    `).run(movementId, req.shopId, productId, productId, req.shopId, quantity, reference, notes, createdBy || String(req.userId), now);

    const updatedInv = db.prepare('SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?')
      .get(req.shopId, productId);

    if (updatedInv && updatedInv.quantity <= updatedInv.min_stock_level) {
      const alertId = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      db.prepare(`
        INSERT OR IGNORE INTO stock_alerts (id, shop_id, product_id, type, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(alertId, req.shopId, productId,
        updatedInv.quantity <= 0 ? 'out_of_stock' : 'low_stock', now);
    }

    res.json({ success: true, movementId });
  } catch (error) {
    console.error('Stock in error:', error);
    res.status(500).json({ error: 'Failed to process stock in' });
  }
});

// Stock Out
router.post('/stock-out', (req, res) => {
  const { shopId, productId, quantity, reference, notes, createdBy } = req.body;

  if (!shopId || !productId || !quantity) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!requireOwnedShop(req, res, shopId)) {
    return;
  }

  const product = getOwnedProduct(productId, req.userId);
  if (!product || product.shop_id !== req.shopId) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const movementId = `mov_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  try {
    let inventory = db.prepare('SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?')
      .get(req.shopId, productId);

    if (!inventory || inventory.quantity < quantity) {
      return res.status(400).json({
        error: 'Insufficient stock',
        available: inventory ? inventory.quantity : 0
      });
    }

    db.prepare('UPDATE inventory SET quantity = quantity - ?, updated_at = ? WHERE id = ?')
      .run(quantity, now, inventory.id);

    db.prepare(`
      INSERT INTO stock_movements (id, inventory_id, product_id, shop_id, type, quantity, reference, notes, created_by, created_at)
      VALUES (?, (SELECT id FROM inventory WHERE shop_id = ? AND product_id = ?), ?, ?, 'out', ?, ?, ?, ?, ?)
    `).run(movementId, req.shopId, productId, productId, req.shopId, quantity, reference, notes, createdBy || String(req.userId), now);

    const updatedInv = db.prepare('SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?')
      .get(req.shopId, productId);

    if (updatedInv && updatedInv.quantity <= 0) {
      const alertId = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      db.prepare(`
        INSERT OR IGNORE INTO stock_alerts (id, shop_id, product_id, type, created_at)
        VALUES (?, ?, ?, 'out_of_stock', ?)
      `).run(alertId, req.shopId, productId, now);
    }

    res.json({ success: true, movementId });
  } catch (error) {
    console.error('Stock out error:', error);
    res.status(500).json({ error: 'Failed to process stock out' });
  }
});

// Adjustment
router.post('/adjustment', (req, res) => {
  const { shopId, productId, adjustment, notes, createdBy } = req.body;

  if (!shopId || !productId || adjustment === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!requireOwnedShop(req, res, shopId)) {
    return;
  }

  const product = getOwnedProduct(productId, req.userId);
  if (!product || product.shop_id !== req.shopId) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const movementId = `mov_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  try {
    let inventory = db.prepare('SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?')
      .get(req.shopId, productId);

    if (inventory) {
      db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = ? WHERE id = ?')
        .run(adjustment, now, inventory.id);
    } else {
      const invId = `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      db.prepare(`
        INSERT INTO inventory (id, shop_id, product_id, quantity, min_stock_level, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 10, 'active', ?, ?)
      `).run(invId, req.shopId, productId, adjustment > 0 ? adjustment : 0, now, now);
    }

    db.prepare(`
      INSERT INTO stock_movements (id, inventory_id, product_id, shop_id, type, quantity, reference, notes, created_by, created_at)
      VALUES (?, (SELECT id FROM inventory WHERE shop_id = ? AND product_id = ?), ?, ?, 'adjustment', ?, ?, ?, ?, ?)
    `).run(movementId, req.shopId, productId, productId, req.shopId, adjustment, 'Adjustment', notes, createdBy || String(req.userId), now);

    res.json({ success: true, movementId });
  } catch (error) {
    console.error('Adjustment error:', error);
    res.status(500).json({ error: 'Failed to process adjustment' });
  }
});

// Get alerts
router.get('/:shopId/alerts', (req, res) => {
  const { shopId } = req.params;
  const { unreadOnly } = req.query;

  if (!requireOwnedShop(req, res, shopId)) {
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

  const alerts = db.prepare(query).all(req.shopId);
  res.json(alerts);
});

// Mark alert as read
router.put('/alerts/:id/read', (req, res) => {
  const { id } = req.params;
  const alert = getOwnedAlert(id, req.userId);

  if (!alert) {
    return res.status(404).json({ error: 'Alert not found' });
  }

  db.prepare('UPDATE stock_alerts SET is_read = 1 WHERE id = ? AND shop_id IN (SELECT id FROM shops WHERE user_id = ?)')
    .run(id, req.userId);
  res.json({ success: true });
});

// Get inventory summary
router.get('/:shopId/summary', (req, res) => {
  const { shopId } = req.params;

  if (!requireOwnedShop(req, res, shopId)) {
    return;
  }

  const summary = db.prepare(`
    SELECT 
      COUNT(*) as total_products,
      SUM(CASE WHEN i.quantity <= 0 THEN 1 ELSE 0 END) as out_of_stock,
      SUM(CASE WHEN i.quantity > 0 AND i.quantity <= i.min_stock_level THEN 1 ELSE 0 END) as low_stock,
      SUM(COALESCE(i.quantity, 0)) as total_stock,
      SUM(COALESCE(i.quantity, 0) * COALESCE(p.price, 0)) as total_value
    FROM products p
    LEFT JOIN inventory i ON p.id = i.product_id
    WHERE p.shop_id = ?
  `).get(req.shopId);

  res.json(summary);
});

module.exports = router;
