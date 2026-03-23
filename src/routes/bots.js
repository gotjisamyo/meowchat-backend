const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

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
