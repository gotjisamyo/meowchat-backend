const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');
const { EVENTS } = require('../events');

const router = express.Router();

router.use(authMiddleware, requireAdmin);

// GET /api/admin/stats — aggregate stats for admin dashboard
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();
    const [
      totalShops,
      totalUsers,
      planCounts,
      recentShops,
    ] = await Promise.all([
      db.get('SELECT COUNT(*) as count FROM shops'),
      db.get('SELECT COUNT(*) as count FROM users'),
      db.all(`SELECT plan, COUNT(*) as count FROM shops GROUP BY plan`),
      db.all(`
        SELECT s.id, s.name, s.plan, s.created_at, u.email as owner_email
        FROM shops s LEFT JOIN users u ON u.id = s.user_id
        ORDER BY s.created_at DESC LIMIT 10
      `),
    ]);

    const byPlan = { free: 0, starter: 0, business: 0, enterprise: 0 };
    planCounts.forEach(r => { byPlan[r.plan] = r.count; });

    res.json({
      totalShops: totalShops.count,
      totalUsers: totalUsers.count,
      activeShops: totalShops.count,
      byPlan,
      recentShops,
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users — list all users with shop count
router.get('/users', async (req, res) => {
  try {
    const db = getDb();
    const users = await db.all(`
      SELECT u.id, u.email, u.name, u.role, u.created_at,
             COUNT(s.id) as shop_count
      FROM users u
      LEFT JOIN shops s ON s.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Promote a user to admin or user role (admin only)
router.patch('/users/role', async (req, res) => {
  try {
    const { email, role } = req.body;
    const allowedRoles = ['admin', 'user', 'manager'];
    if (!email || !role || !allowedRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid input', message: 'กรุณาระบุ email และ role ที่ถูกต้อง' });
    }
    const db = getDb();
    const target = await db.get('SELECT id, email, role FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!target) {
      return res.status(404).json({ error: 'User not found', message: 'ไม่พบผู้ใช้' });
    }
    await db.run('UPDATE users SET role = ? WHERE email = ?', [role, email.toLowerCase()]);
    res.json({ message: `อัปเดต role เป็น ${role} สำเร็จ`, user: { ...target, role } });
  } catch (error) {
    console.error('Promote user error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

router.get('/shops', async (req, res) => {
  try {
    const db = getDb();
    const shops = await db.all(`
      SELECT
        s.*,
        u.email AS owner_email,
        u.name AS owner_name,
        u.role AS owner_role,
        (
          SELECT pn.status
          FROM payment_notifications pn
          WHERE pn.shop_id = s.id
          ORDER BY pn.created_at DESC
          LIMIT 1
        ) AS latest_payment_status,
        (
          SELECT pn.created_at
          FROM payment_notifications pn
          WHERE pn.shop_id = s.id
          ORDER BY pn.created_at DESC
          LIMIT 1
        ) AS latest_payment_at
      FROM shops s
      LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
    `);

    res.json({ shops });
  } catch (error) {
    console.error('Admin get shops error:', error);
    res.status(500).json({ error: 'Server error', message: 'ไม่สามารถดึงข้อมูลร้านค้าได้' });
  }
});

router.patch('/shops/:id/plan', async (req, res) => {
  try {
    const { plan } = req.body || {};
    const allowedPlans = ['free', 'starter', 'business', 'enterprise'];

    if (!plan || !allowedPlans.includes(String(plan).toLowerCase())) {
      return res.status(400).json({
        error: 'Invalid plan',
        message: 'แพ็กเกจไม่ถูกต้อง'
      });
    }

    const db = getDb();
    const existingShop = await db.get('SELECT * FROM shops WHERE id = ?', [req.params.id]);

    if (!existingShop) {
      return res.status(404).json({ error: 'Shop not found', message: 'ไม่พบร้านค้า' });
    }

    await db.run(`
      UPDATE shops
      SET plan = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [String(plan).toLowerCase(), req.params.id]);

    const shop = await db.get(`
      SELECT s.*, u.email AS owner_email, u.name AS owner_name, u.role AS owner_role
      FROM shops s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
    `, [req.params.id]);

    res.json({ message: 'อัปเดตแพ็กเกจร้านสำเร็จ', shop });
  } catch (error) {
    console.error('Admin update plan error:', error);
    res.status(500).json({ error: 'Server error', message: 'ไม่สามารถอัปเดตแพ็กเกจได้' });
  }
});

router.get('/payments', async (req, res) => {
  try {
    const db = getDb();
    const payments = await db.all(`
      SELECT pn.*, s.name AS shop_name
      FROM payment_notifications pn
      LEFT JOIN shops s ON s.id = pn.shop_id
      ORDER BY
        CASE pn.status
          WHEN 'pending' THEN 0
          WHEN 'approved' THEN 1
          WHEN 'rejected' THEN 2
          ELSE 3
        END,
        pn.created_at DESC
    `);

    res.json({ payments });
  } catch (error) {
    console.error('Admin get payments error:', error);
    res.status(500).json({ error: 'Server error', message: 'ไม่สามารถดึงข้อมูลแจ้งโอนได้' });
  }
});

router.post('/payments/:id/approve', async (req, res) => {
  try {
    const db = getDb();
    const payment = await db.get('SELECT * FROM payment_notifications WHERE id = ?', [req.params.id]);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found', message: 'ไม่พบรายการแจ้งโอน' });
    }

    if (payment.status !== 'pending') {
      return res.status(409).json({ error: 'Payment already processed', message: `รายการนี้ถูกดำเนินการแล้ว (${payment.status})` });
    }

    await db.run(`
      UPDATE payment_notifications
      SET status = 'approved', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [req.params.id]);

    // Unlock bot and activate subscription for the shop
    if (payment.shop_id) {
      const paidUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await db.run(
        `UPDATE shops
         SET bot_locked = FALSE, subscription_status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [payment.shop_id]
      );
      // Upsert active subscription record
      const existingSub = await db.get(
        `SELECT id FROM subscriptions WHERE shop_id = ? AND status = 'active' LIMIT 1`,
        [payment.shop_id]
      );
      if (existingSub) {
        await db.run(
          `UPDATE subscriptions SET payment_status = 'completed', end_date = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ?`,
          [paidUntil, existingSub.id]
        );
      } else {
        await db.run(
          `INSERT INTO subscriptions (shop_id, plan_id, status, payment_method, payment_status, end_date)
           VALUES (?, 2, 'active', 'bank_transfer', 'completed', ?)
           ON CONFLICT DO NOTHING`,
          [payment.shop_id, paidUntil]
        );
      }
      console.log(`[admin] approved payment id=${req.params.id} → unlocked shop=${payment.shop_id}`);
    }

    const updatedPayment = await db.get('SELECT * FROM payment_notifications WHERE id = ?', [req.params.id]);

    res.json({ message: 'อนุมัติการแจ้งโอนเรียบร้อยแล้ว', payment: updatedPayment });
  } catch (error) {
    console.error('Admin approve payment error:', error);
    res.status(500).json({ error: 'Server error', message: 'ไม่สามารถอนุมัติการแจ้งโอนได้' });
  }
});

// GET /api/admin/trials-expiring — shops with trial ending in next 7 days
router.get('/trials-expiring', async (req, res) => {
  try {
    const db = getDb();
    const shops = await db.all(`
      SELECT s.id, s.name, s.trial_ends_at, s.line_notify_token, u.email as owner_email,
             EXTRACT(DAY FROM s.trial_ends_at - NOW()) as days_left
      FROM shops s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.trial_ends_at IS NOT NULL
        AND s.trial_ends_at > NOW()
        AND s.trial_ends_at <= NOW() + INTERVAL '7 days'
      ORDER BY s.trial_ends_at ASC
    `);
    res.json({ shops });
  } catch (err) {
    console.error('Admin trials-expiring error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/shops/:shopId/extend-trial — extend trial by N days
router.post('/shops/:shopId/extend-trial', async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;
    const rawDays = parseInt(req.body.days) || 7;
    const days = Math.min(Math.max(rawDays, 1), 365); // cap 1–365 days

    const shop = await db.get('SELECT * FROM shops WHERE id = ?', [shopId]);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const base = shop.trial_ends_at ? new Date(shop.trial_ends_at) : new Date();
    const newEndsAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    await db.run(
      `UPDATE shops
       SET trial_ends_at = ?, trial_reminder_sent = FALSE,
           bot_locked = FALSE, subscription_status = 'trial',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [newEndsAt.toISOString(), shopId]
    );

    console.log(`[admin] extended trial for shop=${shopId} by ${days} days → ${newEndsAt.toISOString()}`);
    res.json({ message: `ยืด trial ออก ${days} วัน`, trial_ends_at: newEndsAt.toISOString() });
  } catch (error) {
    console.error('Admin extend trial error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/payments/:id/reject', async (req, res) => {
  try {
    const db = getDb();
    const payment = await db.get('SELECT * FROM payment_notifications WHERE id = ?', [req.params.id]);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found', message: 'ไม่พบรายการแจ้งโอน' });
    }

    if (payment.status !== 'pending') {
      return res.status(409).json({ error: 'Payment already processed', message: `รายการนี้ถูกดำเนินการแล้ว (${payment.status})` });
    }

    await db.run(`
      UPDATE payment_notifications
      SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [req.params.id]);

    const updatedPayment = await db.get('SELECT * FROM payment_notifications WHERE id = ?', [req.params.id]);

    res.json({ message: 'ปฏิเสธการแจ้งโอนเรียบร้อยแล้ว', payment: updatedPayment });
  } catch (error) {
    console.error('Admin reject payment error:', error);
    res.status(500).json({ error: 'Server error', message: 'ไม่สามารถปฏิเสธการแจ้งโอนได้' });
  }
});

// GET /api/admin/funnel — conversion funnel stats
router.get('/funnel', async (_req, res) => {
  try {
    const db = getDb();
    const [s1, s2, s3, s4] = await Promise.all([
      db.get(`SELECT COUNT(DISTINCT shop_id) as n FROM shop_events WHERE event = ?`, [EVENTS.TRIAL_STARTED]),
      db.get(`SELECT COUNT(DISTINCT shop_id) as n FROM shop_events WHERE event = ?`, [EVENTS.BOT_ACTIVATED]),
      db.get(`SELECT COUNT(DISTINCT shop_id) as n FROM shop_events WHERE event = ?`, [EVENTS.FIRST_REPLY]),
      db.get(`SELECT COUNT(DISTINCT shop_id) as n FROM shop_events WHERE event = ?`, [EVENTS.UPGRADE_CLICKED]),
    ]);
    const steps = [
      { key: 'trial_started',   label: 'ทดลองใช้',         count: Number(s1?.n ?? 0) },
      { key: 'bot_activated',   label: 'เปิดใช้ Bot',       count: Number(s2?.n ?? 0) },
      { key: 'first_reply',     label: 'Bot ตอบครั้งแรก',   count: Number(s3?.n ?? 0) },
      { key: 'upgrade_clicked', label: 'กด Upgrade',        count: Number(s4?.n ?? 0) },
    ];
    // Compute drop-off % relative to trial_started
    const base = steps[0].count || 1;
    const funnel = steps.map(s => ({ ...s, pct: Math.round((s.count / base) * 100) }));
    res.json({ funnel });
  } catch (err) {
    console.error('Admin funnel error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/analytics/platform — cross-merchant bot activity
router.get('/analytics/platform', async (_req, res) => {
  try {
    const db = getDb();
    const [totals, topShops, topWords] = await Promise.all([
      // Platform-wide totals (last 30 days)
      db.get(`
        SELECT
          COUNT(DISTINCT cv.id) as total_conversations,
          COUNT(cm.id) as total_messages,
          COUNT(DISTINCT cv.line_user_id) as unique_users,
          COUNT(CASE WHEN cv.escalated = 1 THEN 1 END) as escalations
        FROM conversations cv
        LEFT JOIN conversation_messages cm ON cm.conversation_id = cv.id
        WHERE cv.created_at >= NOW() - INTERVAL '30 days'
      `),
      // Top 5 most active shops by message count
      db.all(`
        SELECT cv.shop_id, s.name as shop_name,
          COUNT(cm.id) as message_count,
          COUNT(DISTINCT cv.line_user_id) as unique_users
        FROM conversations cv
        JOIN conversation_messages cm ON cm.conversation_id = cv.id
        LEFT JOIN shops s ON s.id = cv.shop_id
        WHERE cv.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY cv.shop_id, s.name
        ORDER BY message_count DESC
        LIMIT 5
      `),
      // Top keywords across all user messages
      db.all(`
        SELECT cm.content FROM conversation_messages cm
        WHERE cm.role = 'user' AND cm.created_at >= NOW() - INTERVAL '30 days'
        LIMIT 500
      `),
    ]);

    // Simple keyword frequency
    const stopwords = new Set(['ครับ','ค่ะ','คะ','นะ','ๆ','และ','แล้ว','ก็','ได้','ไม่','มี','ที่','จะ','ว่า','ใน','ของ','กับ','หรือ','แต่','เป็น','ให้','มา','ไป','อยู่']);
    const freq = {};
    for (const { content } of topWords) {
      const words = content.replace(/[^\u0E00-\u0E7Fa-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !stopwords.has(w));
      for (const w of words) freq[w] = (freq[w] || 0) + 1;
    }
    const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([word, count]) => ({ word, count }));

    res.json({
      totals: {
        totalConversations: Number(totals?.total_conversations || 0),
        totalMessages: Number(totals?.total_messages || 0),
        uniqueUsers: Number(totals?.unique_users || 0),
        escalations: Number(totals?.escalations || 0),
      },
      topShops: topShops.map(s => ({
        shopId: s.shop_id,
        shopName: s.shop_name || s.shop_id,
        messageCount: Number(s.message_count || 0),
        uniqueUsers: Number(s.unique_users || 0),
      })),
      keywords,
    });
  } catch (err) {
    console.error('Admin platform analytics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/credits/:id/approve — approve a pending credit purchase
router.post('/credits/:id/approve', async (req, res) => {
  try {
    const db = getDb();
    const credit = await db.get('SELECT * FROM merchant_credits WHERE id = ?', [req.params.id]);
    if (!credit) return res.status(404).json({ error: 'Credit record not found' });
    if (credit.status !== 'pending') {
      return res.status(409).json({ error: 'Credit already processed', message: `สถานะปัจจุบัน: ${credit.status}` });
    }
    await db.run(
      `UPDATE merchant_credits SET status = 'approved' WHERE id = ?`,
      [req.params.id]
    );
    await db.run(
      `UPDATE payment_notifications SET status = 'approved' WHERE id =
        (SELECT payment_notification_id FROM merchant_credits WHERE id = ?)`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/credits/pending — list pending credit purchases
router.get('/credits/pending', async (_req, res) => {
  try {
    const db = getDb();
    const rows = await db.all(
      `SELECT mc.*, s.name as shop_name, cp.name as pack_name, cp.price
       FROM merchant_credits mc
       JOIN shops s ON s.id = mc.shop_id
       LEFT JOIN credit_packs cp ON cp.id = mc.pack_id
       WHERE mc.status = 'pending'
       ORDER BY mc.created_at DESC`
    );
    res.json({ pendingCredits: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/subscriptions — list all subscriptions with optional filters
router.get('/subscriptions', async (req, res) => {
  try {
    const db = getDb();
    const { plan, status } = req.query;

    const conditions = [];
    const params = [];

    if (plan && plan !== 'all') {
      conditions.push(`LOWER(p.name) LIKE LOWER(?)`);
      params.push(`%${plan}%`);
    }
    if (status && status !== 'all') {
      conditions.push(`sub.status = ?`);
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const subscriptions = await db.all(`
      SELECT
        sub.id,
        sub.shop_id,
        sub.status,
        sub.start_date,
        sub.end_date,
        sub.payment_method,
        sub.payment_status,
        sub."createdAt" as created_at,
        s.name as shop_name,
        u.email as owner_email,
        u.name as owner_name,
        p.name as plan_name,
        p.price as plan_price
      FROM subscriptions sub
      LEFT JOIN shops s ON s.id = sub.shop_id
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN plans p ON p.id = sub.plan_id
      ${where}
      ORDER BY sub."createdAt" DESC
    `, params);

    // MRR = sum of active subscription plan prices
    const mrrRow = await db.get(`
      SELECT COALESCE(SUM(p.price), 0) as mrr
      FROM subscriptions sub
      LEFT JOIN plans p ON p.id = sub.plan_id
      WHERE sub.status = 'active'
    `);

    // Counts by plan
    const planCounts = await db.all(`
      SELECT p.name as plan_name, COUNT(*) as count
      FROM subscriptions sub
      LEFT JOIN plans p ON p.id = sub.plan_id
      GROUP BY p.name
    `);

    res.json({
      subscriptions,
      mrr: mrrRow?.mrr ?? 0,
      total: subscriptions.length,
      planCounts,
    });
  } catch (err) {
    console.error('Admin subscriptions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/settings — get admin profile/settings
router.get('/settings', async (req, res) => {
  try {
    const db = getDb();
    const admin = await db.get(
      `SELECT id, name, email, role FROM users WHERE id = ?`,
      [req.user.id]
    );
    res.json({ profile: admin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/settings — update admin profile
router.put('/settings', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name && !email) {
      return res.status(400).json({ error: 'ต้องระบุ name หรือ email' });
    }
    const db = getDb();
    const updates = [];
    const params = [];
    if (name) { updates.push('name = ?'); params.push(name); }
    if (email) { updates.push('email = ?'); params.push(email.toLowerCase()); }
    params.push(req.user.id);
    await db.run(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    const updated = await db.get(
      `SELECT id, name, email, role FROM users WHERE id = ?`,
      [req.user.id]
    );
    res.json({ ok: true, profile: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
