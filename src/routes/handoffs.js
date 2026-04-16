const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = express.Router();

// GET /api/handoffs — list handoffs (admin: all, merchant: own shops)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    let rows;
    if (req.user?.role === 'admin') {
      rows = await db.all(`
        SELECT h.*, s.name AS shop_name
        FROM handoffs h
        LEFT JOIN shops s ON s.id = h.shop_id
        ORDER BY h.created_at DESC
        LIMIT 100
      `);
    } else {
      rows = await db.all(`
        SELECT h.*, s.name AS shop_name
        FROM handoffs h
        LEFT JOIN shops s ON s.id = h.shop_id
        WHERE s.user_id = ?
        ORDER BY h.created_at DESC
        LIMIT 100
      `, [req.userId]);
    }
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/handoffs/:id — update status (resolve / acknowledge)
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['pending', 'active', 'resolved'].includes(status)) {
      return res.status(400).json({ success: false, error: 'invalid status' });
    }
    const db = getDb();
    const resolvedAt = status === 'resolved' ? new Date().toISOString() : null;
    await db.run(
      `UPDATE handoffs SET status = ?, resolved_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, resolvedAt, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
