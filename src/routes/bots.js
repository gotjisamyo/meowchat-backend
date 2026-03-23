const express = require('express');
const { getDb } = require('../db');
const https = require('https');
const crypto = require('crypto');

const router = express.Router();

// Helper: generate shop ID
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// POST /api/bots/setup — save onboarding data (create shop + bot record)
router.post('/setup', async (req, res) => {
  try {
    const {
      businessType,
      shopName,
      phone,
      openHours,
      botName,
      botStyle,
      lineChannelToken,
      lineChannelSecret
    } = req.body;

    if (!shopName) {
      return res.status(400).json({ error: 'shopName is required' });
    }

    const db = getDb();
    const shopId = generateId();

    // Check if user already has a shop (update) or create new one
    const existing = await db.get(
      'SELECT id FROM shops WHERE user_id = ? ORDER BY created_at ASC LIMIT 1',
      [req.userId]
    );

    if (existing) {
      // Update existing shop with onboarding data
      await db.run(`
        UPDATE shops
        SET name = ?,
            description = ?,
            line_access_token = COALESCE(?, line_access_token),
            line_channel_secret = COALESCE(?, line_channel_secret),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `, [
        botName || shopName,
        JSON.stringify({ businessType, shopName, phone, openHours, botStyle }),
        lineChannelToken || null,
        lineChannelSecret || null,
        existing.id,
        req.userId
      ]);

      return res.json({ success: true, botId: existing.id, shopId: existing.id });
    }

    // Create new shop record
    await db.run(`
      INSERT INTO shops (id, user_id, name, description, line_access_token, line_channel_secret, plan, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'free', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      shopId,
      req.userId,
      botName || shopName,
      JSON.stringify({ businessType, shopName, phone, openHours, botStyle }),
      lineChannelToken || '',
      lineChannelSecret || ''
    ]);

    res.json({ success: true, botId: shopId, shopId });
  } catch (error) {
    console.error('Bot setup error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด: ' + error.message });
  }
});

// POST /api/bots/line-test — verify LINE channel credentials
router.post('/line-test', async (req, res) => {
  try {
    const { channelAccessToken, channelSecret } = req.body;

    if (!channelAccessToken) {
      return res.status(400).json({ success: false, error: 'channelAccessToken is required' });
    }

    // Call LINE API to verify token
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.line.me',
        path: '/v2/bot/info',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${channelAccessToken}`
        }
      };

      const request = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            resolve({ statusCode: response.statusCode, body: JSON.parse(data) });
          } catch (e) {
            resolve({ statusCode: response.statusCode, body: {} });
          }
        });
      });

      request.on('error', reject);
      request.end();
    });

    if (result.statusCode === 200) {
      return res.json({
        success: true,
        botName: result.body.displayName || '',
        botPicture: result.body.pictureUrl || ''
      });
    } else {
      return res.json({
        success: false,
        error: 'Invalid credentials',
        detail: result.body.message || 'Token ไม่ถูกต้อง'
      });
    }
  } catch (error) {
    console.error('LINE test error:', error);
    res.status(500).json({ success: false, error: 'Server error', message: error.message });
  }
});

// GET /api/bots — list all bots (shops) for current user
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const bots = await db.all(`
      SELECT s.id, s.name, s.description, s.line_channel_id, s.plan,
             s.created_at, s.updated_at,
             p.name as plan_name, p.max_chats, p.max_agents
      FROM shops s
      LEFT JOIN subscriptions sub ON s.id = sub.shop_id AND sub.status = 'active'
      LEFT JOIN plans p ON sub.plan_id = p.id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
    `, [req.userId]);

    res.json({ bots });
  } catch (error) {
    console.error('Get bots error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/bots/:id — get single bot by id
router.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const bot = await db.get(`
      SELECT s.id, s.name, s.description, s.line_channel_id, s.plan,
             s.created_at, s.updated_at,
             p.name as plan_name, p.max_chats, p.max_agents
      FROM shops s
      LEFT JOIN subscriptions sub ON s.id = sub.shop_id AND sub.status = 'active'
      LEFT JOIN plans p ON sub.plan_id = p.id
      WHERE s.id = ? AND s.user_id = ?
    `, [req.params.id, req.userId]);

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    res.json({ bot });
  } catch (error) {
    console.error('Get bot error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

// PUT /api/bots/:id — update bot settings (name, description/personality, greeting)
router.put('/:id', async (req, res) => {
  try {
    const { name, description, personality, greeting, aiPersonality, aiResponseStyle, aiCustomKnowledge } = req.body;
    const db = getDb();

    // Check ownership
    const existing = await db.get(
      'SELECT id FROM shops WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    );

    if (!existing) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    await db.run(`
      UPDATE shops
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `, [
      name || null,
      description || personality || null,
      req.params.id,
      req.userId
    ]);

    const bot = await db.get('SELECT * FROM shops WHERE id = ?', [req.params.id]);

    res.json({ message: 'อัปเดต bot สำเร็จ', bot });
  } catch (error) {
    console.error('Update bot error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/bots/:botId/conversations — list conversations for a bot
router.get('/:botId/conversations', async (req, res) => {
  try {
    const db = getDb();

    // Verify ownership
    const bot = await db.get(
      'SELECT id FROM shops WHERE id = ? AND user_id = ?',
      [req.params.botId, req.userId]
    );

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    // Fetch customers who have chatted with this shop as conversations
    const conversations = await db.all(`
      SELECT c.id, c.name, c.line_user_id, c.phone, c.email,
             c.customer_group, c.status, c.total_orders, c.total_spent,
             c.last_order_at as last_message_at, c.created_at
      FROM customers c
      WHERE c.shop_id = ? AND c.status != 'deleted'
      ORDER BY c.last_order_at DESC NULLS LAST, c.created_at DESC
      LIMIT 100
    `, [req.params.botId]);

    res.json({ conversations, botId: req.params.botId });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

module.exports = router;
