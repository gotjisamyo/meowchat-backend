const express = require('express');
const multer = require('multer');
const { getDb } = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // 2MB

// POST /api/upload/image — store image in DB, return permanent URL
router.post('/image', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Only JPEG/PNG/WebP/GIF allowed' });
  }
  try {
    const db = getDb();
    const base64 = req.file.buffer.toString('base64');
    const result = await db.run(
      `INSERT INTO uploads (data, mime_type, user_id, created_at) VALUES (?, ?, ?, NOW()) RETURNING id`,
      [base64, req.file.mimetype, req.userId || null]
    );
    const id = result.lastInsertRowid;
    const url = `${process.env.BACKEND_URL || 'https://api.meowchat.store'}/api/upload/serve/${id}`;
    res.json({ url });
  } catch (err) {
    console.error('[upload] DB error:', err.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET /api/upload/serve/:id — serve image from DB (public, no auth)
router.get('/serve/:id', async (req, res) => {
  try {
    const db = getDb();
    const row = await db.get(`SELECT data, mime_type FROM uploads WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).send('Not found');
    const buf = Buffer.from(row.data, 'base64');
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error');
  }
});

module.exports = router;
