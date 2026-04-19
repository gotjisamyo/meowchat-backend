const express = require('express');
const axios = require('axios');
const { getDb } = require('../db');
const { authMiddleware, verifyToken } = require('../auth');

const router = express.Router();

// ── SSE client registry ──────────────────────────────────────────────────────
const sseClients = new Set();

function broadcastHandoffEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_) { /* ignore disconnected */ }
  }
}

// GET /api/handoffs/stream?token=xxx  — real-time SSE feed (must be before /:id routes)
router.get('/stream', (req, res) => {
  const decoded = verifyToken(req.query.token);
  if (!decoded) return res.status(401).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

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

    if (req.user?.role !== 'admin') {
      const owned = await db.get(
        `SELECT h.id FROM handoffs h
         JOIN shops s ON s.id = h.shop_id
         WHERE h.id = ? AND s.user_id = ?`,
        [req.params.id, req.userId]
      );
      if (!owned) return res.status(403).json({ success: false, error: 'forbidden' });
    }

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

// GET /api/handoffs/:id/messages — conversation history for this handoff
router.get('/:id/messages', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const handoff = await db.get(`SELECT * FROM handoffs WHERE id = ?`, [req.params.id]);
    if (!handoff) return res.status(404).json({ success: false, error: 'not found' });

    // Permission: admin sees all, merchant must own the shop
    if (req.user?.role !== 'admin') {
      const owned = await db.get(
        `SELECT s.id FROM shops s WHERE s.id = ? AND s.user_id = ?`,
        [handoff.shop_id, req.userId]
      );
      if (!owned) return res.status(403).json({ success: false, error: 'forbidden' });
    }

    // Find latest conversation for this customer in this shop
    const conv = await db.get(
      `SELECT id FROM conversations WHERE shop_id = ? AND line_user_id = ? ORDER BY updated_at DESC LIMIT 1`,
      [handoff.shop_id, handoff.line_user_id]
    );

    const messages = conv
      ? await db.all(
          `SELECT role, content, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`,
          [conv.id]
        )
      : [];

    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/handoffs/:id/reply — send LINE push message to customer
router.post('/:id/reply', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ success: false, error: 'text required' });

    const db = getDb();
    const handoff = await db.get(
      `SELECT h.*, s.line_access_token FROM handoffs h LEFT JOIN shops s ON s.id = h.shop_id WHERE h.id = ?`,
      [req.params.id]
    );
    if (!handoff) return res.status(404).json({ success: false, error: 'not found' });

    // Permission check
    if (req.user?.role !== 'admin') {
      const owned = await db.get(
        `SELECT s.id FROM shops s WHERE s.id = ? AND s.user_id = ?`,
        [handoff.shop_id, req.userId]
      );
      if (!owned) return res.status(403).json({ success: false, error: 'forbidden' });
    }

    // platform bot uses env token as fallback
    const token = handoff.line_access_token || process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) return res.status(400).json({ success: false, error: 'shop has no LINE token configured' });

    // Send LINE push message
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: handoff.line_user_id, messages: [{ type: 'text', text: text.trim() }] },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );

    // Save to conversation_messages so history is preserved
    const conv = await db.get(
      `SELECT id FROM conversations WHERE shop_id = ? AND line_user_id = ? ORDER BY updated_at DESC LIMIT 1`,
      [handoff.shop_id, handoff.line_user_id]
    );
    const now = new Date().toISOString();
    if (conv) {
      await db.run(
        `INSERT INTO conversation_messages (conversation_id, role, content, created_at) VALUES (?, 'admin', ?, CURRENT_TIMESTAMP)`,
        [conv.id, text.trim()]
      );
      await db.run(`UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [conv.id]);
    }

    // Broadcast to all SSE clients watching the handoffs page
    broadcastHandoffEvent('message_new', {
      handoff_id: req.params.id,
      role: 'admin',
      content: text.trim(),
      created_at: now,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[handoff reply error]', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { router, broadcastHandoffEvent };
