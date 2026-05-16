const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');

// ─── Public router ────────────────────────────────────────────────────────────

const publicRouter = express.Router();

const clickLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// POST /api/promo/click — track link click (called from register page on load)
publicRouter.post('/click', clickLimiter, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const db = getDb();
    const result = await db.run(
      'UPDATE promo_codes SET clicks = clicks + 1 WHERE code = ?',
      [code.toUpperCase()]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Invalid code' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin router ─────────────────────────────────────────────────────────────

const adminRouter = express.Router();
adminRouter.use(authMiddleware, requireAdmin);

// GET /api/admin/promo-codes — list all codes with stats
adminRouter.get('/', async (req, res) => {
  try {
    const db = getDb();
    const codes = await db.all(
      `SELECT p.*,
        (SELECT COUNT(*) FROM users u WHERE u.promo_code = p.code) as total_signups,
        (SELECT COUNT(*) FROM users u
          JOIN shops s ON s.user_id = u.id
          WHERE u.promo_code = p.code AND s.subscription_status IN ('active','trial')
        ) as active_shops
       FROM promo_codes p ORDER BY p.created_at DESC`
    );
    res.json({ codes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/promo-codes — create new code
adminRouter.post('/', async (req, res) => {
  try {
    let { code, label } = req.body;
    if (!code || !label) return res.status(400).json({ error: 'code and label required' });
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    if (!code) return res.status(400).json({ error: 'code must be alphanumeric' });
    const db = getDb();
    await db.run('INSERT INTO promo_codes (code, label) VALUES (?, ?)', [code, label]);
    const created = await db.get('SELECT * FROM promo_codes WHERE code = ?', [code]);
    console.log(`[promo] created code=${code} label="${label}"`);
    res.status(201).json({ code: created });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Code already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/promo-codes/:code — delete
adminRouter.delete('/:code', async (req, res) => {
  try {
    const db = getDb();
    await db.run('DELETE FROM promo_codes WHERE code = ?', [req.params.code.toUpperCase()]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { publicRouter, adminRouter };
