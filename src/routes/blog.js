const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');

const router = express.Router();

// ── Public routes ──────────────────────────────────────────────

// GET /api/blog — list published articles
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const articles = await db.all(`
      SELECT id, slug, title, meta_title, meta_description,
             category, reading_time, excerpt, keywords, created_at, updated_at
      FROM blog_articles
      WHERE published = true
      ORDER BY created_at DESC
    `);
    const parsed = articles.map(a => ({
      ...a,
      keywords: safeParseJSON(a.keywords, []),
    }));
    res.json({ articles: parsed });
  } catch (err) {
    console.error('[blog] GET / error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/blog/:slug — get single article by slug
router.get('/:slug', async (req, res) => {
  try {
    const db = getDb();
    const article = await db.get(
      `SELECT * FROM blog_articles WHERE slug = ? AND published = true`,
      [req.params.slug]
    );
    if (!article) return res.status(404).json({ error: 'Not found' });
    res.json({ article: { ...article, keywords: safeParseJSON(article.keywords, []) } });
  } catch (err) {
    console.error('[blog] GET /:slug error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin routes ───────────────────────────────────────────────

// GET /api/blog/admin/all — list all articles (including drafts)
router.get('/admin/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const articles = await db.all(`
      SELECT id, slug, title, category, reading_time, published, created_at, updated_at
      FROM blog_articles
      ORDER BY created_at DESC
    `);
    res.json({ articles });
  } catch (err) {
    console.error('[blog] GET /admin/all error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/blog/admin/:id — get single article for editing
router.get('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const article = await db.get(
      `SELECT * FROM blog_articles WHERE id = ?`,
      [req.params.id]
    );
    if (!article) return res.status(404).json({ error: 'Not found' });
    res.json({ article: { ...article, keywords: safeParseJSON(article.keywords, []) } });
  } catch (err) {
    console.error('[blog] GET /admin/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/blog/admin — create article
router.post('/admin', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { slug, title, meta_title, meta_description, category, reading_time,
            excerpt, content, keywords, published } = req.body;

    if (!slug || !title) return res.status(400).json({ error: 'slug and title required' });

    const result = await db.run(`
      INSERT INTO blog_articles
        (slug, title, meta_title, meta_description, category, reading_time,
         excerpt, content, keywords, published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [
      slug, title, meta_title || title, meta_description || excerpt || '',
      category || 'คู่มือ', reading_time || '5 นาที',
      excerpt || '', content || '',
      JSON.stringify(keywords || []),
      published ? true : false,
    ]);

    res.json({ id: result.lastInsertRowid, slug });
  } catch (err) {
    if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'slug already exists' });
    }
    console.error('[blog] POST /admin error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/blog/admin/:id — update article
router.put('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { slug, title, meta_title, meta_description, category, reading_time,
            excerpt, content, keywords, published } = req.body;

    await db.run(`
      UPDATE blog_articles SET
        slug = ?, title = ?, meta_title = ?, meta_description = ?,
        category = ?, reading_time = ?, excerpt = ?, content = ?,
        keywords = ?, published = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      slug, title, meta_title || title, meta_description || excerpt || '',
      category || 'คู่มือ', reading_time || '5 นาที',
      excerpt || '', content || '',
      JSON.stringify(keywords || []),
      published ? true : false,
      req.params.id,
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[blog] PUT /admin/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/blog/admin/:id — delete article
router.delete('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    await db.run(`DELETE FROM blog_articles WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[blog] DELETE /admin/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
