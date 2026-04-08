const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = express.Router();

// Strip HTML tags to prevent XSS from being stored in the DB
function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
}


// Get primary shop for current user
router.get('/mine', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const shop = await db.get(`
      SELECT s.id, s.name, s.description, s.line_channel_id as lineOaId, s.created_at as createdAt
      FROM shops s
      WHERE s.user_id = ?
      ORDER BY s.created_at ASC
      LIMIT 1
    `, [req.userId]);

    if (!shop) {
      return res.status(404).json({ error: 'Shop not found', message: 'ไม่พบร้านค้า' });
    }

    res.json({ id: shop.id, name: shop.name, description: shop.description, lineOaId: shop.lineOaId, createdAt: shop.createdAt });
  } catch (error) {
    console.error('Get mine shop error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

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

    const safeName = stripHtml(name);
    const safeDescription = stripHtml(description);

    if (!safeName) {
      return res.status(400).json({
        error: 'Missing name',
        message: 'กรุณากรอกชื่อร้าน'
      });
    }

    const db = getDb();

    // Trial limit: max 1 shop per user on trial plan
    const existingShops = await db.all('SELECT id FROM shops WHERE user_id = ?', [req.userId]);
    if (existingShops.length >= 1) {
      const userSub = await db.get(
        "SELECT status FROM subscriptions WHERE shop_id = ? AND status IN ('trial','active')",
        [existingShops[0].id]
      );
      if (!userSub || userSub.status === 'trial') {
        return res.status(403).json({
          error: 'Trial limit reached',
          message: 'แผนทดลองสร้างได้สูงสุด 1 ร้าน กรุณาอัปเกรดแผน',
          redirect: '/pricing'
        });
      }
    }

    // Generate shop ID
    const shopId = 'shop_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // Guard: if a LINE Channel ID is provided, verify it hasn't been used for a trial before.
    // This prevents users from abusing the free trial by registering with a new email
    // but reusing the same LINE OA (1 LINE OA = 1 trial, ever).
    if (lineChannelId && lineChannelId.trim()) {
      const existingTrial = await db.get(
        'SELECT line_channel_id, shop_id FROM line_channel_trials WHERE line_channel_id = ?',
        [lineChannelId.trim()]
      );
      if (existingTrial) {
        return res.status(409).json({
          error: 'Trial already used',
          message: 'LINE OA นี้เคยใช้สิทธิ์ทดลองฟรีแล้ว กรุณาเลือกแผนที่เหมาะสม',
          redirect: '/pricing'
        });
      }
    }

    // Insert shop (TEXT primary key — no RETURNING id needed, use shopId directly)
    await db.run(`
      INSERT INTO shops (id, user_id, name, description, line_channel_id, line_channel_secret, line_access_token)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      shopId,
      req.userId,
      safeName,
      safeDescription || '',
      lineChannelId || '',
      lineChannelSecret || '',
      lineAccessToken || ''
    ]);

    // Assign Trial plan + set trial_ends_at = 14 days from now
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    try {
      await db.run(`UPDATE shops SET trial_ends_at = ? WHERE id = ?`, [trialEndsAt, shopId]);
      await db.run(`
        INSERT INTO subscriptions (shop_id, plan_id, status, payment_method, payment_status)
        VALUES (?, 1, 'trial', 'free', 'paid')
      `, [shopId]);

      // Record this LINE Channel ID as trial-used so it cannot claim another trial.
      if (lineChannelId && lineChannelId.trim()) {
        await db.run(
          `INSERT INTO line_channel_trials (line_channel_id, shop_id, user_id)
           VALUES (?, ?, ?)
           ON CONFLICT (line_channel_id) DO NOTHING`,
          [lineChannelId.trim(), shopId, req.userId]
        );
      }
    } catch (subErr) {
      console.error('Create trial subscription error (non-fatal):', subErr.message);
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

    // Guard: if changing LINE Channel ID, ensure the new one hasn't been trial-used by a different shop.
    if (lineChannelId && lineChannelId.trim()) {
      const existingTrial = await db.get(
        'SELECT shop_id FROM line_channel_trials WHERE line_channel_id = ?',
        [lineChannelId.trim()]
      );
      // Block only if the trial record belongs to a *different* shop
      if (existingTrial && existingTrial.shop_id !== req.params.id) {
        return res.status(409).json({
          error: 'Trial already used',
          message: 'LINE OA นี้เคยใช้สิทธิ์ทดลองฟรีแล้ว กรุณาเลือกแผนที่เหมาะสม',
          redirect: '/pricing'
        });
      }
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
      name ? stripHtml(name) : null,
      description ? stripHtml(description) : null,
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
