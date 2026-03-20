const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

function getOwnedOrder(db, userId, orderId) {
  return db.prepare(`
    SELECT o.*
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    WHERE o.id = ? AND s.user_id = ?
  `).get(orderId, userId);
}

function getOwnedProduct(db, userId, productId) {
  return db.prepare(`
    SELECT p.*
    FROM products p
    JOIN shops s ON s.id = p.shop_id
    WHERE p.id = ? AND s.user_id = ?
  `).get(productId, userId);
}

function getOwnedCustomer(db, userId, customerId) {
  return db.prepare(`
    SELECT c.*
    FROM customers c
    JOIN shops s ON s.id = c.shop_id
    WHERE c.id = ? AND s.user_id = ?
  `).get(customerId, userId);
}

// Create order with inventory deduction
router.post('/', (req, res) => {
  const db = getDb();
  const {
    shopId, customerId, items, totalAmount,
    paymentMethod, shippingAddress, note
  } = req.body;

  if (!shopId || !items || items.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!requireOwnedShop(req, res, shopId)) {
    return;
  }

  if (customerId && !getOwnedCustomer(db, req.userId, customerId)) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  const orderId = 'ord_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const orderNumber = 'ORD-' + Date.now();
  const now = new Date().toISOString();

  try {
    const orderItems = [];

    for (const item of items) {
      const { productId, quantity, price } = item;
      const product = getOwnedProduct(db, req.userId, productId);

      if (!product || product.shop_id !== req.shopId) {
        return res.status(404).json({ error: 'Product not found', productId });
      }

      const inventory = db.prepare(
        'SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?'
      ).get(req.shopId, productId);

      if (!inventory || inventory.quantity < quantity) {
        return res.status(400).json({
          error: 'Insufficient stock',
          productId,
          available: inventory ? inventory.quantity : 0
        });
      }

      db.prepare(
        'UPDATE inventory SET quantity = quantity - ?, updated_at = ? WHERE id = ?'
      ).run(quantity, now, inventory.id);

      const movId = 'mov_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      db.prepare(`
        INSERT INTO stock_movements (
          id, inventory_id, product_id, shop_id, type,
          quantity, reference, notes, created_by, created_at
        ) VALUES (?, ?, ?, ?, 'out', ?, ?, ?, 'customer_order', ?)
      `).run(movId, inventory.id, productId, req.shopId, quantity, orderNumber, note, now);

      orderItems.push({
        productId,
        productName: product.name || 'Unknown',
        quantity,
        price
      });

      const updatedInv = db.prepare(
        'SELECT * FROM inventory WHERE id = ?'
      ).get(inventory.id);

      if (updatedInv && updatedInv.quantity <= updatedInv.min_stock_level) {
        const alertId = 'alert_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        db.prepare(`
          INSERT OR IGNORE INTO stock_alerts (
            id, shop_id, product_id, type, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(alertId, req.shopId, productId,
          updatedInv.quantity <= 0 ? 'out_of_stock' : 'low_stock', now);
      }
    }

    db.prepare(`
      INSERT INTO orders (
        id, shop_id, customer_id, order_number, status,
        items, total_amount, payment_method, shipping_address,
        note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId, req.shopId, customerId, orderNumber, 'completed',
      JSON.stringify(orderItems), totalAmount, paymentMethod,
      shippingAddress, note, now, now
    );

    if (customerId) {
      db.prepare(`
        UPDATE customers SET
          total_orders = total_orders + 1,
          total_spent = total_spent + ?,
          last_order_at = ?,
          first_order_at = COALESCE(first_order_at, ?),
          updated_at = ?
        WHERE id = ? AND shop_id = ?
      `).run(totalAmount, now, now, now, customerId, req.shopId);
    }

    res.json({
      success: true,
      orderId,
      orderNumber,
      items: orderItems,
      totalAmount
    });

  } catch (error) {
    console.error('Order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Get orders for a shop
router.get('/:shopId', (req, res) => {
  const db = getDb();
  const { shopId } = req.params;
  const { customerId, status } = req.query;

  if (!requireOwnedShop(req, res, shopId)) {
    return;
  }

  if (customerId) {
    const customer = getOwnedCustomer(db, req.userId, customerId);
    if (!customer || customer.shop_id !== req.shopId) {
      return res.status(404).json({ error: 'Customer not found' });
    }
  }

  let query = 'SELECT * FROM orders WHERE shop_id = ?';
  const params = [req.shopId];

  if (customerId) {
    query += ' AND customer_id = ?';
    params.push(customerId);
  }

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT 50';

  const orders = db.prepare(query).all(...params);
  const parsedOrders = orders.map(o => ({
    ...o,
    items: JSON.parse(o.items || '[]')
  }));

  res.json(parsedOrders);
});

// Get single order
router.get('/:shopId/:id', (req, res) => {
  const db = getDb();
  const { shopId, id } = req.params;

  if (!requireOwnedShop(req, res, shopId)) {
    return;
  }

  const order = getOwnedOrder(db, req.userId, id);

  if (!order || order.shop_id !== req.shopId) {
    return res.status(404).json({ error: 'Order not found' });
  }

  order.items = JSON.parse(order.items || '[]');
  res.json(order);
});

// Update order status
router.put('/:shopId/:id/status', (req, res) => {
  const db = getDb();
  const { shopId, id } = req.params;
  const { status } = req.body;

  if (!requireOwnedShop(req, res, shopId)) {
    return;
  }

  const order = getOwnedOrder(db, req.userId, id);
  if (!order || order.shop_id !== req.shopId) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const now = new Date().toISOString();

  db.prepare(
    'UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND shop_id = ?'
  ).run(status, now, id, req.shopId);

  res.json({ success: true });
});

module.exports = router;
