const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = express.Router();

// Get all shops for current user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const shops = await db.all(`
      SELECT s.*, p.name as plan_name, p.price as plan_price
      FROM shops s
      LEFT JOIN subscriptions sub ON s.id = sub.shop_id AND sub.status = 'active'
      LEFT JOIN plans p ON sub.plan_id = p.id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
    `, [req.userId]);

    res.json({ shops });
  } catch (error) {
    console.error('Get shops error:', error);
    res.status(500).json({
      error: 'Server error',
      message: 'เกิดข้อผิดพลาด'
    });
  }
});

// Create new shop
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, description, lineChannelId, lineChannelSecret, lineAccessToken } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'Missing name',
        message: 'กรุณากรอกชื่อร้าน'
      });
    }

    const db = getDb();

    // Generate shop ID
    const shopId = 'shop_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // Insert shop (TEXT primary key — no RETURNING id needed, use shopId directly)
    await db.run(`
      INSERT INTO shops (id, user_id, name, description, line_channel_id, line_channel_secret, line_access_token)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      shopId,
      req.userId,
      name,
      description || '',
      lineChannelId || '',
      lineChannelSecret || '',
      lineAccessToken || ''
    ]);

    // Assign Free plan subscription to new shop
    try {
      await db.run(`
        INSERT INTO subscriptions (shop_id, plan_id, status, payment_method, payment_status)
        VALUES (?, 0, 'active', 'free', 'paid')
      `, [shopId]);
    } catch (subErr) {
      console.error('Create subscription error (non-fatal):', subErr.message);
    }

    // Get the created shop
    const shop = await db.get('SELECT * FROM shops WHERE id = ?', [shopId]);

    res.status(201).json({
      message: 'สร้างร้านค้าสำเร็จ',
      shop
    });
  } catch (error) {
    console.error('Create shop error:', error);
    res.status(500).json({
      error: 'Server error',
      message: 'เกิดข้อผิดพลาด'
    });
  }
});

// Get specific shop
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const shop = await db.get(`
      SELECT s.*, p.name as plan_name, p.price as plan_price
      FROM shops s
      LEFT JOIN subscriptions sub ON s.id = sub.shop_id AND sub.status = 'active'
      LEFT JOIN plans p ON sub.plan_id = p.id
      WHERE s.id = ? AND s.user_id = ?
    `, [req.params.id, req.userId]);

    if (!shop) {
      return res.status(404).json({
        error: 'Shop not found',
        message: 'ไม่พบร้านค้า'
      });
    }

    res.json({ shop });
  } catch (error) {
    console.error('Get shop error:', error);
    res.status(500).json({
      error: 'Server error',
      message: 'เกิดข้อผิดพลาด'
    });
  }
});

// Update shop
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, description, lineChannelId, lineChannelSecret, lineAccessToken } = req.body;
    const db = getDb();

    // Check ownership
    const existingShop = await db.get('SELECT id FROM shops WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);

    if (!existingShop) {
      return res.status(404).json({
        error: 'Shop not found',
        message: 'ไม่พบร้านค้า'
      });
    }

    // Update shop
    await db.run(`
      UPDATE shops
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          line_channel_id = COALESCE(?, line_channel_id),
          line_channel_secret = COALESCE(?, line_channel_secret),
          line_access_token = COALESCE(?, line_access_token),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `, [
      name,
      description,
      lineChannelId,
      lineChannelSecret,
      lineAccessToken,
      req.params.id,
      req.userId
    ]);

    const shop = await db.get('SELECT * FROM shops WHERE id = ?', [req.params.id]);

    res.json({
      message: 'อัปเดตร้านค้าสำเร็จ',
      shop
    });
  } catch (error) {
    console.error('Update shop error:', error);
    res.status(500).json({
      error: 'Server error',
      message: 'เกิดข้อผิดพลาด'
    });
  }
});

// Delete shop
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const db = getDb();

    // Check ownership
    const existingShop = await db.get('SELECT id FROM shops WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);

    if (!existingShop) {
      return res.status(404).json({
        error: 'Shop not found',
        message: 'ไม่พบร้านค้า'
      });
    }

    // Delete shop (cascade will handle related data)
    await db.run('DELETE FROM shops WHERE id = ?', [req.params.id]);

    res.json({
      message: 'ลบร้านค้าสำเร็จ'
    });
  } catch (error) {
    console.error('Delete shop error:', error);
    res.status(500).json({
      error: 'Server error',
      message: 'เกิดข้อผิดพลาด'
    });
  }
});

module.exports = router;
