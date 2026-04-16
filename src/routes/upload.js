const express = require('express');
const multer = require('multer');
const { getDb } = require('../db');

const multerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ── Public router — serve stored images ─────────────────────────────────────
const publicRouter = express.Router();

publicRouter.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const row = await db.get(`SELECT data, mime_type FROM uploads WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).send('Not found');
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.send(Buffer.from(row.data, 'base64'));
  } catch {
    res.status(500).send('Error');
  }
});

// ── Auth router — upload image ────────────────────────────────────────────────
const authRouter = express.Router();

authRouter.post('/image', multerUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!allowed.has(req.file.mimetype)) {
    return res.status(400).json({ error: 'Only JPEG/PNG/WebP/GIF allowed' });
  }
  try {
    const db = getDb();
    const result = await db.run(
      `INSERT INTO uploads (data, mime_type, user_id, created_at) VALUES (?, ?, ?, NOW()) RETURNING id`,
      [req.file.buffer.toString('base64'), req.file.mimetype, req.userId || null]
    );
    const base = process.env.BACKEND_URL || 'https://api.meowchat.store';
    res.json({ url: `${base}/api/upload/serve/${result.lastInsertRowid}` });
  } catch (err) {
    console.error('[upload] error:', err.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = { publicRouter, authRouter };
