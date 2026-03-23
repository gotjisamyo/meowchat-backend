const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/usage — usage stats for current user's shops
router.get('/', async (req, res) => {
  try {
    const db = getDb();

    // Get all shops for this user
    const shops = await db.all(
      'SELECT id FROM shops WHERE user_id = ?',
      [req.userId]
    );

    if (shops.length === 0) {
      return res.json({
        messages_used: 0,
        messages_limit: 300,
        bots_count: 0,
        bots_limit: 1,
        plan: 'Free',
        period_start: null,
        period_end: null,
        shops: []
      });
    }

    const shopIds = shops.map(s => s.id);

    // Get active subscription for first shop (or aggregate across all)
    const subscription = await db.get(`
      SELECT sub.*, p.name as plan_name, p.max_chats, p.max_agents, p.price,
             sub.period_start, sub.period_end
      FROM subscriptions sub
      JOIN plans p ON sub.plan_id = p.id
      WHERE sub.shop_id = ANY(ARRAY[${shopIds.map(() => '?').join(',')}]::text[])
        AND sub.status = 'active'
      ORDER BY sub."createdAt" DESC
      LIMIT 1
    `, shopIds);

    // Get usage tracking for current period
    const usageRows = await db.all(`
      SELECT SUM(chats_count) as total_chats, SUM(agents_count) as total_agents
      FROM usage_tracking
      WHERE shop_id = ANY(ARRAY[${shopIds.map(() => '?').join(',')}]::text[])
        AND period_start >= NOW() - INTERVAL '30 days'
    `, shopIds);

    const usage = usageRows[0] || { total_chats: 0, total_agents: 0 };

    res.json({
      messages_used: Number(usage.total_chats) || 0,
      messages_limit: subscription ? Number(subscription.max_chats) : 300,
      bots_count: shopIds.length,
      bots_limit: subscription ? Number(subscription.max_agents) : 1,
      plan: subscription ? subscription.plan_name : 'free',
      plan_price: subscription ? Number(subscription.price) : 0,
      period_start: subscription ? subscription.period_start : null,
      period_end: subscription ? subscription.period_end : null,
      shops: shopIds
    });
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

module.exports = router;
