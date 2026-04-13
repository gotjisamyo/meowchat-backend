const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
}

// shop_id columns are now added in initDatabase() via ADD COLUMN IF NOT EXISTS

async function requireMarketingShop(req, res) {
  const shopId = req.params.shopId || req.query.shopId || req.body.shopId;
  if (!shopId) {
    res.status(400).json({ error: 'shopId is required' });
    return null;
  }
  return requireOwnedShop(req, res, shopId);
}

async function getOwnedCustomer(db, userId, customerId) {
  return db.get(`
    SELECT c.*
    FROM customers c
    JOIN shops s ON s.id = c.shop_id
    WHERE c.id = ? AND s.user_id = ?
  `, [customerId, userId]);
}

router.get('/campaigns', async (req, res) => {
  try {
    if (!await requireMarketingShop(req, res)) return;
    const db = getDb();
    const campaigns = await db.all(
      'SELECT * FROM marketing_campaigns WHERE shop_id = ? ORDER BY created_at DESC',
      [req.shopId]
    );
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/campaigns', async (req, res) => {
  try {
    const { shopId, name, type, trigger, steps, templateId } = req.body;
    if (!shopId || !name) {
      return res.status(400).json({ error: 'shopId and name are required' });
    }
    if (!await requireOwnedShop(req, res, shopId)) return;

    const ALLOWED_TYPES = ['auto', 'welcome', 'reminder', 'abandonment', 'review', 'promotion', 'reengage'];
    const ALLOWED_TRIGGERS = ['signup', 'purchase', 'inactivity', 'trial_end', 'manual'];
    const safeType = ALLOWED_TYPES.includes(type) ? type : 'auto';
    const safeTrigger = ALLOWED_TRIGGERS.includes(trigger) ? trigger : 'signup';

    const db = getDb();
    const result = await db.run(`
      INSERT INTO marketing_campaigns (shop_id, name, type, trigger, steps, status, template_id)
      VALUES (?, ?, ?, ?, ?, 'active', ?) RETURNING id
    `, [req.shopId, stripHtml(name), safeType, safeTrigger, JSON.stringify(steps || []), templateId || null]);

    res.json({ success: true, id: result.lastInsertRowid, templateId: templateId || null });
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

router.post('/apply-template', async (req, res) => {
  try {
    const { shopId, templateId, customerId, channel } = req.body;
    if (!shopId || !templateId || !customerId) {
      return res.status(400).json({ error: 'shopId, templateId and customerId are required' });
    }
    if (!await requireOwnedShop(req, res, shopId)) return;

    const db = getDb();
    const customer = await getOwnedCustomer(db, req.userId, customerId);
    if (!customer || customer.shop_id !== req.shopId) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const ALLOWED_CHANNELS = ['line', 'email', 'sms'];
    const safeChannel = ALLOWED_CHANNELS.includes(channel) ? channel : 'line';

    const result = await db.run(`
      INSERT INTO marketing_automations (shop_id, customer_id, template_id, channel, status, next_send)
      VALUES (?, ?, ?, ?, 'active', NOW()) RETURNING id
    `, [req.shopId, customerId, templateId, safeChannel]);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/schedule', async (req, res) => {
  try {
    const { shopId, customerId, message, sendAt, channel } = req.body;
    if (!shopId || !customerId || !message || !sendAt) {
      return res.status(400).json({ error: 'shopId, customerId, message and sendAt are required' });
    }
    if (typeof message !== 'string' || message.length > 2000) {
      return res.status(400).json({ error: 'message must be ≤ 2000 characters' });
    }
    if (Number.isNaN(new Date(sendAt).getTime())) {
      return res.status(400).json({ error: 'sendAt is not a valid date' });
    }
    if (!await requireOwnedShop(req, res, shopId)) return;

    const db = getDb();
    const customer = await getOwnedCustomer(db, req.userId, customerId);
    if (!customer || customer.shop_id !== req.shopId) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const result = await db.run(`
      INSERT INTO marketing_scheduled (shop_id, customer_id, message, send_at, channel, status)
      VALUES (?, ?, ?, ?, ?, 'pending') RETURNING id
    `, [req.shopId, customerId, message, sendAt, channel || 'line']);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/scheduled/:customerId', async (req, res) => {
  try {
    if (!await requireMarketingShop(req, res)) return;
    const db = getDb();
    const customer = await getOwnedCustomer(db, req.userId, req.params.customerId);
    if (!customer || customer.shop_id !== req.shopId) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const messages = await db.all(`
      SELECT * FROM marketing_scheduled
      WHERE shop_id = ? AND customer_id = ? AND status = 'pending'
      ORDER BY send_at ASC
    `, [req.shopId, req.params.customerId]);

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/broadcast', async (req, res) => {
  try {
    const { shopId, message, filter } = req.body;
    if (!shopId || !message) {
      return res.status(400).json({ error: 'shopId and message are required' });
    }
    if (typeof message !== 'string' || message.length > 2000) {
      return res.status(400).json({ error: 'message must be ≤ 2000 characters' });
    }
    if (!await requireOwnedShop(req, res, shopId)) return;

    const db = getDb();
    let query = "SELECT id FROM customers WHERE shop_id = ? AND status = 'active'";
    const params = [req.shopId];

    if (filter?.group) {
      query += ' AND customer_group = ?';
      params.push(filter.group);
    }

    const customers = await db.all(query, params);

    for (const customer of customers) {
      await db.run(`
        INSERT INTO marketing_scheduled (shop_id, customer_id, message, send_at, channel, status)
        VALUES (?, ?, ?, NOW(), 'line', 'pending')
      `, [req.shopId, customer.id, message]);
    }

    res.json({ success: true, count: customers.length, message: `ส่งถึง ${customers.length} คนแล้วค่ะ!` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    if (!await requireMarketingShop(req, res)) return;
    const db = getDb();

    const [
      { count: totalCampaigns },
      { count: activeAutomations },
      { count: pendingMessages },
      { count: sentMessages }
    ] = await Promise.all([
      db.get('SELECT COUNT(*) as count FROM marketing_campaigns WHERE shop_id = ?', [req.shopId]),
      db.get("SELECT COUNT(*) as count FROM marketing_automations WHERE shop_id = ? AND status = 'active'", [req.shopId]),
      db.get("SELECT COUNT(*) as count FROM marketing_scheduled WHERE shop_id = ? AND status = 'pending'", [req.shopId]),
      db.get("SELECT COUNT(*) as count FROM marketing_scheduled WHERE shop_id = ? AND status = 'sent'", [req.shopId]),
    ]);

    res.json({
      totalCampaigns: Number(totalCampaigns) || 0,
      activeAutomations: Number(activeAutomations) || 0,
      pendingMessages: Number(pendingMessages) || 0,
      sentMessages: Number(sentMessages) || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
