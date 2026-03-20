// Team Management System
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

async function getOwnedMember(db, userId, memberId) {
  return db.get(`
    SELECT tm.*
    FROM team_members tm
    JOIN shops s ON s.id = tm.shop_id
    WHERE tm.id = ? AND s.user_id = ?
  `, [memberId, userId]);
}

// Get all team members
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.query;

    if (!shopId) {
      return res.status(400).json({ error: 'shopId is required' });
    }

    if (!await requireOwnedShop(req, res, shopId)) {
      return;
    }

    const members = await db.all(
      'SELECT * FROM team_members WHERE shop_id = ? ORDER BY created_at DESC',
      [req.shopId]
    );
    res.json(members);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add team member
router.post('/', async (req, res) => {
  try {
    const db = getDb();
    const { name, role, email, phone, shopId } = req.body;

    if (!shopId || !name) {
      return res.status(400).json({ error: 'shopId and name are required' });
    }

    if (!await requireOwnedShop(req, res, shopId)) {
      return;
    }

    const result = await db.run(`
      INSERT INTO team_members (name, role, email, phone, shop_id, created_at)
      VALUES (?, ?, ?, ?, ?, NOW()) RETURNING id
    `, [name, role || 'member', email || '', phone || '', req.shopId]);

    res.json({ id: result.lastInsertRowid, name, role: role || 'member', email, phone, shopId: req.shopId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update team member
router.put('/:id', async (req, res) => {
  try {
    const db = getDb();
    const { name, role, email, phone, status } = req.body;
    const { id } = req.params;

    const member = await getOwnedMember(db, req.userId, id);
    if (!member) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    await db.run(`
      UPDATE team_members SET name = ?, role = ?, email = ?, phone = ?, status = ?
      WHERE id = ? AND shop_id = ?
    `, [name, role, email, phone, status, id, member.shop_id]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete team member
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const member = await getOwnedMember(db, req.userId, id);
    if (!member) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    await db.run('DELETE FROM team_members WHERE id = ? AND shop_id = ?', [id, member.shop_id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
