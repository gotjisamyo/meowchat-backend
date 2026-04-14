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

// POST /api/credits/purchase/:shopId — request to buy a credit pack (manual/slip flow)
router.post('/purchase/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;
    const { packId } = req.body;
    if (!packId) return res.status(400).json({ error: 'packId required' });

    const pack = await db.get(`SELECT * FROM credit_packs WHERE id = ? AND is_active = 1`, [packId]);
    if (!pack) return res.status(404).json({ error: 'pack not found' });

    // Generate a unique reference number for this purchase
    const refNumber = `CR-${Date.now()}-${shopId.slice(-6)}`;

    // Create a payment notification record for this credit purchase
    const paymentResult = await db.run(
      `INSERT INTO payment_notifications
         (shop_id, payer_name, amount, transfer_date, bank_name, account_name, account_number, ref_number, status)
       VALUES (?, ?, ?, CURRENT_DATE, 'กสิกรไทย (Kasikornbank)', 'นายกฤษฐาพงศ์ จิรกุลวิชยวงษ์', '089-3-66849-7', ?, 'pending')
       RETURNING id`,
      [shopId, `Credit Pack ${pack.name}`, pack.price, refNumber]
    );
    const paymentId = paymentResult.lastInsertRowid;

    // Create merchant_credits record in pending state — expires_at uses inline SQL expression
    await db.run(
      `INSERT INTO merchant_credits (shop_id, messages_added, pack_id, payment_notification_id, status, expires_at)
       VALUES (?, ?, ?, ?, 'pending', NOW() + INTERVAL '90 days')`,
      [shopId, pack.messages, pack.id, paymentId]
    );

    res.json({
      ok: true,
      paymentId,
      refNumber,
      pack: { name: pack.name, messages: pack.messages, price: pack.price },
      bankInfo: {
        bankName: 'กสิกรไทย (Kasikornbank)',
        accountName: 'นายกฤษฐาพงศ์ จิรกุลวิชยวงษ์',
        accountNumber: '089-3-66849-7',
      },
      instructions: `โอนเงิน ฿${pack.price} แล้วแนบสลิปพร้อมอ้างอิงเลข ${refNumber} ในหน้า Subscription เพื่อให้ทีมงาน activate เครดิต`,
    });
  } catch (err) {
    console.error('[credits/purchase] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/credits/submit-slip/:shopId — merchant submits payment slip after purchase
router.post('/submit-slip/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;
    const { paymentId, refNumber, proofBase64, proofFileName, proofContentType } = req.body;

    if (!paymentId && !refNumber) {
      return res.status(400).json({ error: 'paymentId or refNumber required' });
    }

    // Find the payment notification
    let notification = null;
    if (paymentId) {
      notification = await db.get(
        `SELECT id FROM payment_notifications WHERE id = ? AND shop_id = ?`,
        [paymentId, shopId]
      );
    } else if (refNumber) {
      notification = await db.get(
        `SELECT id FROM payment_notifications WHERE ref_number = ? AND shop_id = ?`,
        [refNumber, shopId]
      );
    }

    if (!notification) {
      return res.status(404).json({ error: 'payment record not found' });
    }

    // Attach slip image to the notification
    await db.run(
      `UPDATE payment_notifications
       SET proof_base64 = ?, proof_file_name = ?, proof_content_type = ?,
           status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [proofBase64 || null, proofFileName || null, proofContentType || null, notification.id]
    );

    res.json({
      ok: true,
      message: 'บันทึกสลิปเรียบร้อย ทีมงานจะตรวจสอบและเปิดเครดิตภายใน 24 ชั่วโมง',
    });
  } catch (err) {
    console.error('[credits/submit-slip] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/credits/pending/:shopId — list pending credit purchases for merchant
router.get('/pending/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;

    const pending = await db.all(
      `SELECT mc.id, mc.messages_added, mc.status, mc.created_at,
              pn.amount, pn.ref_number, pn.proof_file_name, pn.status as payment_status,
              cp.name as pack_name
       FROM merchant_credits mc
       LEFT JOIN payment_notifications pn ON pn.id = mc.payment_notification_id
       LEFT JOIN credit_packs cp ON cp.id = mc.pack_id
       WHERE mc.shop_id = ? AND mc.status != 'approved'
       ORDER BY mc.created_at DESC`,
      [shopId]
    );

    res.json({ pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/credits/usage/:shopId — current month usage including credits
router.get('/usage/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;

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
