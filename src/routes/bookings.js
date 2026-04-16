const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

// GET /api/bookings/:shopId — list bookings, optional ?status=
router.get('/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { status } = req.query;
    if (!await requireOwnedShop(req, res, shopId)) return;

    const db = getDb();
    let sql = `SELECT * FROM bookings WHERE shop_id = ?`;
    const params = [req.shopId];
    if (status) { sql += ` AND status = ?`; params.push(status); }
    sql += ` ORDER BY booking_datetime ASC, created_at DESC`;

    const rows = await db.all(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Error getting bookings:', err);
    res.status(500).json({ error: 'Failed to get bookings' });
  }
});

// PUT /api/bookings/:id/status — update booking status
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const VALID = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (!VALID.includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }

    const db = getDb();
    const booking = await db.get(
      `SELECT b.* FROM bookings b JOIN shops s ON s.id = b.shop_id WHERE b.id = ? AND s.user_id = ?`,
      [id, req.userId]
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    await db.run(
      `UPDATE bookings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating booking:', err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

module.exports = router;
