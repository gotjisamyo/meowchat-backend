const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');

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

    await db.run(`
      UPDATE payment_notifications
      SET status = 'approved', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [req.params.id]);

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
    const days = parseInt(req.body.days) || 7;

    const shop = await db.get('SELECT * FROM shops WHERE id = ?', [shopId]);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const base = shop.trial_ends_at ? new Date(shop.trial_ends_at) : new Date();
    const newEndsAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    await db.run(
      `UPDATE shops SET trial_ends_at = ?, trial_reminder_sent = FALSE WHERE id = ?`,
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

module.exports = router;
