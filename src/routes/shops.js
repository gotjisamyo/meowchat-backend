const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = express.Router();

// Get all shops for current user
router.get('/', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const shops = db.prepare(`
      SELECT s.*, p.name as plan_name, p.price as plan_price
      FROM shops s
      LEFT JOIN subscriptions sub ON s.id = sub.shop_id AND sub.status = 'active'
      LEFT JOIN plans p ON sub.plan_id = p.id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
    `).all(req.userId);

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
router.post('/', authMiddleware, (req, res) => {
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

    // Insert shop
    const result = db.prepare(`
      INSERT INTO shops (id, user_id, name, description, line_channel_id, line_channel_secret, line_access_token)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      shopId, 
      req.userId, 
      name, 
      description || '',
      lineChannelId || '',
      lineChannelSecret || '',
      lineAccessToken || ''
    );

    // Get the created shop
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId);

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
router.get('/:id', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const shop = db.prepare(`
      SELECT s.*, p.name as plan_name, p.price as plan_price
      FROM shops s
      LEFT JOIN subscriptions sub ON s.id = sub.shop_id AND sub.status = 'active'
      LEFT JOIN plans p ON sub.plan_id = p.id
      WHERE s.id = ? AND s.user_id = ?
    `).get(req.params.id, req.userId);

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
router.put('/:id', authMiddleware, (req, res) => {
  try {
    const { name, description, lineChannelId, lineChannelSecret, lineAccessToken } = req.body;
    const db = getDb();

    // Check ownership
    const existingShop = db.prepare('SELECT id FROM shops WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);

    if (!existingShop) {
      return res.status(404).json({ 
        error: 'Shop not found',
        message: 'ไม่พบร้านค้า' 
      });
    }

    // Update shop
    db.prepare(`
      UPDATE shops 
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          line_channel_id = COALESCE(?, line_channel_id),
          line_channel_secret = COALESCE(?, line_channel_secret),
          line_access_token = COALESCE(?, line_access_token),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(
      name,
      description,
      lineChannelId,
      lineChannelSecret,
      lineAccessToken,
      req.params.id,
      req.userId
    );

    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);

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
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const db = getDb();

    // Check ownership
    const existingShop = db.prepare('SELECT id FROM shops WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);

    if (!existingShop) {
      return res.status(404).json({ 
        error: 'Shop not found',
        message: 'ไม่พบร้านค้า' 
      });
    }

    // Delete shop (cascade will handle related data)
    db.prepare('DELETE FROM shops WHERE id = ?').run(req.params.id);

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
