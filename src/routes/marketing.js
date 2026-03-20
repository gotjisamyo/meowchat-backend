const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(col => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initMarketingTenantColumns() {
  const db = getDb();
  ensureColumn(db, 'marketing_campaigns', 'shop_id', 'TEXT');
  ensureColumn(db, 'marketing_automations', 'shop_id', 'TEXT');
  ensureColumn(db, 'marketing_scheduled', 'shop_id', 'TEXT');
}

initMarketingTenantColumns();

function requireMarketingShop(req, res) {
  const shopId = req.params.shopId || req.query.shopId || req.body.shopId;
  if (!shopId) {
    res.status(400).json({ error: 'shopId is required' });
    return null;
  }
  return requireOwnedShop(req, res, shopId);
}

function getOwnedCustomer(db, userId, customerId) {
  return db.prepare(`
    SELECT c.*
    FROM customers c
    JOIN shops s ON s.id = c.shop_id
    WHERE c.id = ? AND s.user_id = ?
  `).get(customerId, userId);
}

router.get('/campaigns', (req, res) => {
  try {
    if (!requireMarketingShop(req, res)) return;
    const db = getDb();
    const campaigns = db.prepare(
      'SELECT * FROM marketing_campaigns WHERE shop_id = ? ORDER BY created_at DESC'
    ).all(req.shopId);
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/campaigns', (req, res) => {
  try {
    const { shopId, name, type, trigger, steps } = req.body;
    if (!shopId || !name) {
      return res.status(400).json({ error: 'shopId and name are required' });
    }
    if (!requireOwnedShop(req, res, shopId)) return;

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO marketing_campaigns (shop_id, name, type, trigger, steps, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(req.shopId, name, type || 'auto', trigger || 'signup', JSON.stringify(steps || []));

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/templates', (req, res) => {
  const templates = [
    { id: 1, name: '👋 Welcome Series', description: 'ส่งข้อความต้อนรับอัตโนมัติเมื่อลูกค้าสมัคร', type: 'welcome', steps: [{ day: 0, message: 'สวัสดีค่ะ! ยินดีต้อนรับสู่ MeowChat! 🎉' }] },
    { id: 2, name: '🎁 Free Trial Reminder', description: 'เตือนก่อน trial หมด', type: 'reminder', steps: [{ day: -7, message: '⏰ ทดลองใช้ฟรีเหลือ 7 วัน!' }] },
    { id: 3, name: '🛒 Cart Abandonment', description: 'เตือนลูกค้าที่ยังไม่ได้ซื้อ', type: 'abandonment', steps: [{ day: 0, message: '🛒 ลืมสินค้าไว้นะคะ!' }] },
    { id: 4, name: '⭐ Review Request', description: 'ขอรีวิวหลังซื้อ', type: 'review', steps: [{ day: 7, message: '⭐ ใช้งานเป็นยังไงบ้างคะ?' }] },
    { id: 5, name: '📢 Promotion Campaign', description: 'ส่งโปรโมชั่นอัตโนมัติ', type: 'promotion', steps: [{ day: 0, message: '🎉 โปรโมชั่นพิเศษ!' }] },
    { id: 6, name: '💌 Re-engagement', description: 'กลับมาง่ายๆ', type: 'reengage', steps: [{ day: 30, message: '🥺 คิดถึงจ้า!' }] }
  ];
  res.json(templates);
});

router.post('/apply-template', (req, res) => {
  try {
    const { shopId, templateId, customerId, channel } = req.body;
    if (!shopId || !templateId || !customerId) {
      return res.status(400).json({ error: 'shopId, templateId and customerId are required' });
    }
    if (!requireOwnedShop(req, res, shopId)) return;

    const db = getDb();
    const customer = getOwnedCustomer(db, req.userId, customerId);
    if (!customer || customer.shop_id !== req.shopId) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const result = db.prepare(`
      INSERT INTO marketing_automations (shop_id, customer_id, template_id, channel, status, next_send)
      VALUES (?, ?, ?, ?, 'active', datetime('now'))
    `).run(req.shopId, customerId, templateId, channel || 'line');

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/schedule', (req, res) => {
  try {
    const { shopId, customerId, message, sendAt, channel } = req.body;
    if (!shopId || !customerId || !message || !sendAt) {
      return res.status(400).json({ error: 'shopId, customerId, message and sendAt are required' });
    }
    if (!requireOwnedShop(req, res, shopId)) return;

    const db = getDb();
    const customer = getOwnedCustomer(db, req.userId, customerId);
    if (!customer || customer.shop_id !== req.shopId) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const result = db.prepare(`
      INSERT INTO marketing_scheduled (shop_id, customer_id, message, send_at, channel, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(req.shopId, customerId, message, sendAt, channel || 'line');

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/scheduled/:customerId', (req, res) => {
  try {
    if (!requireMarketingShop(req, res)) return;
    const db = getDb();
    const customer = getOwnedCustomer(db, req.userId, req.params.customerId);
    if (!customer || customer.shop_id !== req.shopId) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const messages = db.prepare(`
      SELECT * FROM marketing_scheduled
      WHERE shop_id = ? AND customer_id = ? AND status = 'pending'
      ORDER BY send_at ASC
    `).all(req.shopId, req.params.customerId);

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/broadcast', (req, res) => {
  try {
    const { shopId, message, filter } = req.body;
    if (!shopId || !message) {
      return res.status(400).json({ error: 'shopId and message are required' });
    }
    if (!requireOwnedShop(req, res, shopId)) return;

    const db = getDb();
    let query = "SELECT id FROM customers WHERE shop_id = ? AND status = 'active'";
    const params = [req.shopId];

    if (filter?.group) {
      query += ' AND customer_group = ?';
      params.push(filter.group);
    }

    const customers = db.prepare(query).all(...params);
    const insertStmt = db.prepare(`
      INSERT INTO marketing_scheduled (shop_id, customer_id, message, send_at, channel, status)
      VALUES (?, ?, ?, datetime('now'), 'line', 'pending')
    `);

    customers.forEach(customer => insertStmt.run(req.shopId, customer.id, message));

    res.json({ success: true, count: customers.length, message: `ส่งถึง ${customers.length} คนแล้วค่ะ!` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', (req, res) => {
  try {
    if (!requireMarketingShop(req, res)) return;
    const db = getDb();

    const totalCampaigns = db.prepare('SELECT COUNT(*) as count FROM marketing_campaigns WHERE shop_id = ?').get(req.shopId).count;
    const activeAutomations = db.prepare("SELECT COUNT(*) as count FROM marketing_automations WHERE shop_id = ? AND status = 'active'").get(req.shopId).count;
    const pendingMessages = db.prepare("SELECT COUNT(*) as count FROM marketing_scheduled WHERE shop_id = ? AND status = 'pending'").get(req.shopId).count;
    const sentMessages = db.prepare("SELECT COUNT(*) as count FROM marketing_scheduled WHERE shop_id = ? AND status = 'sent'").get(req.shopId).count;

    res.json({ totalCampaigns, activeAutomations, pendingMessages, sentMessages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
