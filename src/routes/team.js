// Team Management System
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

router.use(authMiddleware);

function getOwnedMember(db, userId, memberId) {
  return db.prepare(`
    SELECT tm.*
    FROM team_members tm
    JOIN shops s ON s.id = tm.shop_id
    WHERE tm.id = ? AND s.user_id = ?
  `).get(memberId, userId);
}

// Get all team members
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.query;

    if (!shopId) {
      return res.status(400).json({ error: 'shopId is required' });
    }

    if (!requireOwnedShop(req, res, shopId)) {
      return;
    }

    const members = db.prepare(
      'SELECT * FROM team_members WHERE shop_id = ? ORDER BY created_at DESC'
    ).all(req.shopId);
    res.json(members);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add team member
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { name, role, email, phone, shopId } = req.body;

    if (!shopId || !name) {
      return res.status(400).json({ error: 'shopId and name are required' });
    }

    if (!requireOwnedShop(req, res, shopId)) {
      return;
    }

    const stmt = db.prepare(`
      INSERT INTO team_members (name, role, email, phone, shop_id, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);

    const result = stmt.run(name, role || 'member', email || '', phone || '', req.shopId);
    res.json({ id: result.lastInsertRowid, name, role: role || 'member', email, phone, shopId: req.shopId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update team member
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const { name, role, email, phone, status } = req.body;
    const { id } = req.params;

    const member = getOwnedMember(db, req.userId, id);
    if (!member) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    const stmt = db.prepare(`
      UPDATE team_members SET name = ?, role = ?, email = ?, phone = ?, status = ?
      WHERE id = ? AND shop_id = ?
    `);

    stmt.run(name, role, email, phone, status, id, member.shop_id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete team member
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;

    const member = getOwnedMember(db, req.userId, id);
    if (!member) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    db.prepare('DELETE FROM team_members WHERE id = ? AND shop_id = ?').run(id, member.shop_id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
