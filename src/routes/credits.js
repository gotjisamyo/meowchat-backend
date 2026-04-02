const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireOwnedShop } = require('../middleware/shopAccess');

// GET /api/credits/packs — list available credit packs
router.get('/packs', async (_req, res) => {
  try {
    const db = getDb();
    const packs = await db.all(`SELECT * FROM credit_packs WHERE is_active = 1 ORDER BY price ASC`);
    res.json({ packs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/credits/balance/:shopId — merchant credit balance
router.get('/balance/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;

    // Active credits (approved, not expired)
    const credits = await db.all(
      `SELECT id, messages_added, messages_used, created_at, expires_at, status
       FROM merchant_credits
       WHERE shop_id = ? AND status = 'approved'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at ASC`,
      [shopId]
    );

    const totalAvailable = credits.reduce((sum, c) =>
      sum + Math.max(0, c.messages_added - c.messages_used), 0
    );

    res.json({ credits, totalAvailable });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/credits/purchase/:shopId — request to buy a credit pack
router.post('/purchase/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;
    const { packId } = req.body;
    if (!packId) return res.status(400).json({ error: 'packId required' });

    const pack = await db.get(`SELECT * FROM credit_packs WHERE id = ? AND is_active = 1`, [packId]);
    if (!pack) return res.status(404).json({ error: 'pack not found' });

    // Create a payment notification for this credit purchase
    const result = await db.run(
      `INSERT INTO payment_notifications
         (shop_id, payer_name, amount, transfer_date, bank_name, account_name, account_number, status)
       VALUES (?, ?, ?, CURRENT_DATE, 'SCB', 'MeowChat', '123-4-56789-0', 'pending') RETURNING id`,
      [shopId, `Credit Pack ${pack.name}`, pack.price]
    );
    const paymentId = result.lastInsertRowid;

    // Create merchant_credits record in pending state
    await db.run(
      `INSERT INTO merchant_credits (shop_id, messages_added, pack_id, payment_notification_id, status, expires_at)
       VALUES (?, ?, ?, ?, 'pending', NOW() + INTERVAL '90 days')`,
      [shopId, pack.messages, pack.id, paymentId]
    );

    res.json({
      ok: true,
      paymentId,
      pack: { name: pack.name, messages: pack.messages, price: pack.price },
      instructions: 'โอนเงินแล้วแจ้งสลิปในหน้า Subscription เพื่อให้ทีมงาน activate เครดิต',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/credits/usage/:shopId — current month usage including credits
router.get('/usage/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;

    const shop = await db.get(`SELECT * FROM shops WHERE id = ?`, [shopId]);
    const sub = await db.get(
      `SELECT p.max_chats FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.shop_id = ? AND s.status = 'active' ORDER BY s.created_at DESC LIMIT 1`,
      [shopId]
    );

    // Messages used this month
    const usageRow = await db.get(
      `SELECT COUNT(*) as cnt FROM conversation_messages cm
       JOIN conversations cv ON cv.id = cm.conversation_id
       WHERE cv.shop_id = ? AND cm.role = 'user'
         AND date_trunc('month', cm.created_at) = date_trunc('month', NOW())`,
      [shopId]
    );
    const used = Number(usageRow?.cnt || 0);
    const planLimit = sub?.max_chats ?? 300;

    // Extra credits available
    const creditsRow = await db.get(
      `SELECT COALESCE(SUM(messages_added - messages_used), 0) as extra
       FROM merchant_credits
       WHERE shop_id = ? AND status = 'approved'
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [shopId]
    );
    const extraCredits = Number(creditsRow?.extra || 0);
    const totalLimit = planLimit === -1 ? -1 : planLimit + extraCredits;

    res.json({ used, planLimit, extraCredits, totalLimit, shopId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
