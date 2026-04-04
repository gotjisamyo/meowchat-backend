const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

async function getOwnedCustomer(db, userId, customerId) {
  return db.get(`
    SELECT c.*
    FROM customers c
    JOIN shops s ON s.id = c.shop_id
    WHERE c.id = ? AND s.user_id = ?
  `, [customerId, userId]);
}

// Get all customers for a shop
router.get('/list/:shopId', async (req, res) => {
  const db = getDb();
  const { shopId } = req.params;
  const { group, search } = req.query;

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  let query = 'SELECT * FROM customers WHERE shop_id = ?';
  const params = [req.shopId];

  if (group) {
    query += ' AND customer_group = ?';
    params.push(group);
  }

  if (search) {
    query += ' AND (name LIKE ? OR phone LIKE ? OR line_user_id LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY created_at DESC';

  const customers = await db.all(query, params);
  res.json(customers);
});

// Get customer stats
router.get('/:shopId/stats', async (req, res) => {
  const db = getDb();
  const { shopId } = req.params;

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  const stats = await db.get(`
    SELECT
      COUNT(*) as total_customers,
      SUM(CASE WHEN customer_group = 'vip' THEN 1 ELSE 0 END) as vip_customers,
      COALESCE(SUM(total_orders), 0) as total_orders,
      COALESCE(SUM(total_spent), 0) as total_revenue,
      COALESCE(AVG(total_spent), 0) as avg_spent
    FROM customers
    WHERE shop_id = ? AND status = 'active'
  `, [req.shopId]);

  res.json(stats || { total_customers: 0, vip_customers: 0, total_orders: 0, total_revenue: 0, avg_spent: 0 });
});

// Get customer groups
router.get('/:shopId/groups', async (req, res) => {
  const db = getDb();
  const { shopId } = req.params;

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  const groups = await db.all(`
    SELECT
      customer_group as group_name,
      COUNT(*) as count,
      SUM(total_spent) as revenue
    FROM customers
    WHERE shop_id = ? AND status = 'active'
    GROUP BY customer_group
  `, [req.shopId]);

  res.json(groups);
});

// Get single customer
router.get('/:shopId/:id', async (req, res) => {
  const db = getDb();
  const { shopId, id } = req.params;

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  const customer = await getOwnedCustomer(db, req.userId, id);

  if (!customer || customer.shop_id !== req.shopId) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  const orders = await db.all(`
    SELECT * FROM orders
    WHERE customer_id = ? AND shop_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `, [id, req.shopId]);

  res.json({ customer, orders });
});

// Create customer
router.post('/', async (req, res) => {
  const db = getDb();
  const {
    shopId, lineUserId, name, phone, email,
    address, note, customerGroup
  } = req.body;

  if (!shopId || !name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  const id = `cust_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  try {
    await db.run(`
      INSERT INTO customers (
        id, shop_id, line_user_id, name, phone, email,
        address, note, customer_group, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `, [
      id, req.shopId, lineUserId, name, phone, email,
      address, note, customerGroup || 'regular', now, now
    ]);

    const customer = await db.get('SELECT * FROM customers WHERE id = ? AND shop_id = ?', [id, req.shopId]);
    res.json(customer);
  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// Update customer
router.put('/:id', async (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { name, phone, email, address, note, customerGroup, status } = req.body;
  const now = new Date().toISOString();

  const customer = await getOwnedCustomer(db, req.userId, id);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  try {
    await db.run(`
      UPDATE customers SET
        name = COALESCE(?, name),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        address = COALESCE(?, address),
        note = COALESCE(?, note),
        customer_group = COALESCE(?, customer_group),
        status = COALESCE(?, status),
        updated_at = ?
      WHERE id = ? AND shop_id = ?
    `, [name, phone, email, address, note, customerGroup, status, now, id, customer.shop_id]);

    const updatedCustomer = await db.get('SELECT * FROM customers WHERE id = ?', [id]);
    res.json(updatedCustomer);
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// Delete customer
router.delete('/:id', async (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const customer = await getOwnedCustomer(db, req.userId, id);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  await db.run('UPDATE customers SET status = ?, updated_at = ? WHERE id = ? AND shop_id = ?',
    ['deleted', new Date().toISOString(), id, customer.shop_id]);
  res.json({ success: true });
});

// Get customer by LINE user ID
router.get('/by-line/:shopId/:lineUserId', async (req, res) => {
  const db = getDb();
  const { shopId, lineUserId } = req.params;

  if (!await requireOwnedShop(req, res, shopId)) {
    return;
  }

  const customer = await db.get(
    'SELECT * FROM customers WHERE shop_id = ? AND line_user_id = ?',
    [req.shopId, lineUserId]
  );

  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  res.json(customer);
});

// Add order to customer
router.post('/:id/order', async (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { amount } = req.body;
  const now = new Date().toISOString();

  const customer = await getOwnedCustomer(db, req.userId, id);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  await db.run(`
    UPDATE customers SET
      total_orders = total_orders + 1,
      total_spent = total_spent + ?,
      last_order_at = ?,
      first_order_at = COALESCE(first_order_at, ?),
      updated_at = ?
    WHERE id = ? AND shop_id = ?
  `, [amount, now, now, now, id, customer.shop_id]);

  res.json({ success: true });
});

async function getLineProfile(lineUserId, lineChannelAccessToken) {
  try {
    const response = await axios.get(
      `https://api.line.me/v2/bot/profile/${lineUserId}`,
      {
        headers: {
          'Authorization': `Bearer ${lineChannelAccessToken}`
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('LINE profile error:', error.response?.data || error.message);
    return null;
  }
}

// Create or update customer from LINE
router.post('/sync-line', async (req, res) => {
  const db = getDb();
  const { shopId, lineUserId } = req.body;

  if (!shopId || !lineUserId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const shop = await requireOwnedShop(req, res, shopId);
  if (!shop) {
    return;
  }

  try {
    let customer = await db.get(
      'SELECT * FROM customers WHERE shop_id = ? AND line_user_id = ?',
      [req.shopId, lineUserId]
    );

    if (customer) {
      return res.json(customer);
    }

    let lineProfile = null;
    // Use shop's own access token from DB — never trust client-supplied token
    if (shop.line_access_token) {
      lineProfile = await getLineProfile(lineUserId, shop.line_access_token);
    }

    const id = `cust_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();

    await db.run(`
      INSERT INTO customers (
        id, shop_id, line_user_id, name, phone, email,
        address, note, customer_group, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'regular', 'active', ?, ?)
    `, [
      id, req.shopId, lineUserId,
      lineProfile?.displayName || 'LINE User',
      null,
      null,
      null,
      lineProfile?.statusMessage || null,
      now,
      now
    ]);

    customer = await db.get('SELECT * FROM customers WHERE id = ? AND shop_id = ?', [id, req.shopId]);
    res.json(customer);
  } catch (error) {
    console.error('Sync LINE customer error:', error);
    res.status(500).json({ error: 'Failed to sync customer' });
  }
});

module.exports = router;
