const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');

const router = express.Router();

router.use(authMiddleware, requireAdmin);

router.get('/shops', (req, res) => {
  try {
    const db = getDb();
    const shops = db.prepare(`
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
    `).all();

    res.json({ shops });
  } catch (error) {
    console.error('Admin get shops error:', error);
    res.status(500).json({ error: 'Server error', message: 'ไม่สามารถดึงข้อมูลร้านค้าได้' });
  }
});

router.patch('/shops/:id/plan', (req, res) => {
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
    const existingShop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);

    if (!existingShop) {
      return res.status(404).json({ error: 'Shop not found', message: 'ไม่พบร้านค้า' });
    }

    db.prepare(`
      UPDATE shops
      SET plan = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(String(plan).toLowerCase(), req.params.id);

    const shop = db.prepare(`
      SELECT s.*, u.email AS owner_email, u.name AS owner_name, u.role AS owner_role
      FROM shops s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
    `).get(req.params.id);

    res.json({ message: 'อัปเดตแพ็กเกจร้านสำเร็จ', shop });
  } catch (error) {
    console.error('Admin update plan error:', error);
    res.status(500).json({ error: 'Server error', message: 'ไม่สามารถอัปเดตแพ็กเกจได้' });
  }
});

router.get('/payments', (req, res) => {
  try {
    const db = getDb();
    const payments = db.prepare(`
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
    `).all();

    res.json({ payments });
  } catch (error) {
    console.error('Admin get payments error:', error);
    res.status(500).json({ error: 'Server error', message: 'ไม่สามารถดึงข้อมูลแจ้งโอนได้' });
  }
});

router.post('/payments/:id/approve', (req, res) => {
  try {
    const db = getDb();
    const payment = db.prepare('SELECT * FROM payment_notifications WHERE id = ?').get(req.params.id);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found', message: 'ไม่พบรายการแจ้งโอน' });
    }

    db.prepare(`
      UPDATE payment_notifications
      SET status = 'approved', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);

    const updatedPayment = db.prepare('SELECT * FROM payment_notifications WHERE id = ?').get(req.params.id);

    res.json({ message: 'อนุมัติการแจ้งโอนเรียบร้อยแล้ว', payment: updatedPayment });
  } catch (error) {
    console.error('Admin approve payment error:', error);
    res.status(500).json({ error: 'Server error', message: 'ไม่สามารถอนุมัติการแจ้งโอนได้' });
  }
});

router.post('/payments/:id/reject', (req, res) => {
  try {
    const db = getDb();
    const payment = db.prepare('SELECT * FROM payment_notifications WHERE id = ?').get(req.params.id);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found', message: 'ไม่พบรายการแจ้งโอน' });
    }

    db.prepare(`
      UPDATE payment_notifications
      SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);

    const updatedPayment = db.prepare('SELECT * FROM payment_notifications WHERE id = ?').get(req.params.id);

    res.json({ message: 'ปฏิเสธการแจ้งโอนเรียบร้อยแล้ว', payment: updatedPayment });
  } catch (error) {
    console.error('Admin reject payment error:', error);
    res.status(500).json({ error: 'Server error', message: 'ไม่สามารถปฏิเสธการแจ้งโอนได้' });
  }
});

module.exports = router;
