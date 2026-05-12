const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireAdmin } = require('../auth');

const router = express.Router();

const FB_API = 'https://graph.facebook.com/v21.0';
const PAGE_ID = () => process.env.FB_PAGE_ID;
const PAGE_TOKEN = () => process.env.FB_PAGE_TOKEN;
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// ── Helpers ────────────────────────────────────────────────────

async function fbPost(path, body) {
  const res = await fetch(`${FB_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: PAGE_TOKEN() }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function fbGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: PAGE_TOKEN() }).toString();
  const res = await fetch(`${FB_API}${path}?${qs}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function generateWithGemini(prompt) {
  if (!GEMINI_KEY()) throw new Error('GEMINI_API_KEY not set');
  const model = 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ── List posts ─────────────────────────────────────────────────

router.get('/', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { status, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT * FROM facebook_posts';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(Number(limit), Number(offset));
    const posts = await db.all(sql, params);
    res.json({ posts });
  } catch (err) {
    console.error('[fb] GET / error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Get single post ────────────────────────────────────────────

router.get('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const post = await db.get('SELECT * FROM facebook_posts WHERE id = $1', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Not found' });
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create draft ───────────────────────────────────────────────

router.post('/', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { title, content, image_url, scheduled_at, notes } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const row = await db.get(`
      INSERT INTO facebook_posts (title, content, image_url, scheduled_at, notes, source)
      VALUES ($1, $2, $3, $4, $5, 'manual')
      RETURNING *
    `, [title || null, content, image_url || null, scheduled_at || null, notes || null]);
    res.status(201).json({ post: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update post ────────────────────────────────────────────────

router.patch('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { title, content, image_url, scheduled_at, status, notes } = req.body;
    const row = await db.get(`
      UPDATE facebook_posts SET
        title = COALESCE($1, title),
        content = COALESCE($2, content),
        image_url = COALESCE($3, image_url),
        scheduled_at = COALESCE($4, scheduled_at),
        status = COALESCE($5, status),
        notes = COALESCE($6, notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $7 RETURNING *
    `, [title, content, image_url, scheduled_at, status, notes, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ post: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete post ────────────────────────────────────────────────

router.delete('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    await db.run('DELETE FROM facebook_posts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI: Generate post drafts ───────────────────────────────────

router.post('/ai/generate', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const { topic, count = 3 } = req.body;

    // Pull recent performance data to guide AI
    const topPosts = await db.all(`
      SELECT content, performance_score, likes, shares, reach
      FROM facebook_posts
      WHERE status = 'published' AND performance_score > 0
      ORDER BY performance_score DESC LIMIT 5
    `);

    const perfContext = topPosts.length > 0
      ? `\n\nโพสที่ได้ผลดีที่สุดในอดีต:\n${topPosts.map((p, i) =>
          `${i + 1}. Score ${p.performance_score.toFixed(1)} | Reach ${p.reach} | เนื้อหา: "${p.content.slice(0, 120)}..."`
        ).join('\n')}`
      : '';

    const topicLine = topic ? `\n\nหัวข้อที่ต้องการ: ${topic}` : '';

    const prompt = `คุณคือ Social Media Manager ของ MeowChat — AI Chatbot สำหรับ LINE OA ที่ช่วยธุรกิจไทย SME ตอบแชทอัตโนมัติ

สร้าง ${count} โพส Facebook ที่แตกต่างกัน สำหรับเพจ "Meow Chat" ที่จะช่วยดึงดูด เจ้าของร้านค้า ร้านอาหาร คลินิก ร้านบริการ ให้สนใจและ engage${topicLine}${perfContext}

กฎ:
- ภาษาไทยเป็นหลัก เป็นกันเอง ไม่เป็นทางการ
- เริ่มด้วย hook ที่ดึงดูด (คำถาม, สถานการณ์จริง, ตัวเลขน่าสนใจ)
- มี CTA ปิดท้าย (ทดลองฟรี 14 วัน ที่ meowchat.store)
- ความยาว 100-200 คำ
- ใช้ emoji ได้แต่ไม่มากเกิน 5 ตัว
- อย่าใช้ hashtag

ตอบในรูปแบบ JSON array เท่านั้น ไม่มีข้อความอื่น:
[
  { "title": "ชื่อโพส (ใช้ภายในเท่านั้น)", "content": "เนื้อหาโพส", "notes": "เหตุผลที่คิดว่าจะได้ผล" },
  ...
]`;

    const raw = await generateWithGemini(prompt);

    // Extract JSON from response
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('AI did not return valid JSON array');
    const drafts = JSON.parse(match[0]);

    // Save to DB
    const saved = [];
    for (const d of drafts) {
      const row = await db.get(`
        INSERT INTO facebook_posts (title, content, notes, source, status)
        VALUES ($1, $2, $3, 'ai', 'draft') RETURNING *
      `, [d.title || null, d.content, d.notes || null]);
      saved.push(row);
    }

    res.json({ posts: saved, count: saved.length });
  } catch (err) {
    console.error('[fb] AI generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Publish post immediately ───────────────────────────────────

router.post('/:id/publish', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const post = await db.get('SELECT * FROM facebook_posts WHERE id = $1', [req.params.id]);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.status === 'published') return res.status(400).json({ error: 'Already published' });

    const fbBody = { message: post.content };
    if (post.image_url) fbBody.link = post.image_url;

    const result = await fbPost(`/${PAGE_ID()}/feed`, fbBody);

    const updated = await db.get(`
      UPDATE facebook_posts SET
        status = 'published',
        fb_post_id = $1,
        published_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 RETURNING *
    `, [result.id, post.id]);

    res.json({ post: updated, fb_post_id: result.id });
  } catch (err) {
    console.error('[fb] publish error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Sync analytics from FB ─────────────────────────────────────

router.post('/:id/sync-analytics', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const post = await db.get('SELECT * FROM facebook_posts WHERE id = $1', [req.params.id]);
    if (!post || !post.fb_post_id) return res.status(400).json({ error: 'No FB post ID' });

    const insights = await fbGet(`/${post.fb_post_id}`, {
      fields: 'likes.summary(true),comments.summary(true),shares,insights.metric(post_impressions_unique)',
    });

    const likes = insights.likes?.summary?.total_count || 0;
    const comments = insights.comments?.summary?.total_count || 0;
    const shares = insights.shares?.count || 0;
    const reach = insights.insights?.data?.[0]?.values?.[0]?.value || 0;
    const score = likes * 1 + comments * 3 + shares * 5 + (reach / 100);

    const updated = await db.get(`
      UPDATE facebook_posts SET
        likes = $1, comments = $2, shares = $3, reach = $4,
        performance_score = $5, updated_at = CURRENT_TIMESTAMP
      WHERE id = $6 RETURNING *
    `, [likes, comments, shares, reach, score, post.id]);

    res.json({ post: updated });
  } catch (err) {
    console.error('[fb] sync-analytics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Cron: auto-publish scheduled posts ────────────────────────
// Called by an external cron (or internal interval)

router.post('/cron/run', async (req, res) => {
  // Simple shared-secret guard to prevent unauthorized triggers
  const secret = req.headers['x-cron-secret'] || req.body?.secret;
  if (secret !== process.env.CRON_SECRET && process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = getDb();
  const now = new Date().toISOString();
  const due = await db.all(`
    SELECT * FROM facebook_posts
    WHERE status = 'scheduled' AND scheduled_at <= $1
    ORDER BY scheduled_at ASC LIMIT 10
  `, [now]);

  const results = [];
  for (const post of due) {
    try {
      const fbBody = { message: post.content };
      if (post.image_url) fbBody.link = post.image_url;
      const result = await fbPost(`/${PAGE_ID()}/feed`, fbBody);
      await db.run(`
        UPDATE facebook_posts SET status='published', fb_post_id=$1,
          published_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$2
      `, [result.id, post.id]);
      results.push({ id: post.id, status: 'published', fb_post_id: result.id });
    } catch (err) {
      await db.run(`
        UPDATE facebook_posts SET status='failed', notes=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2
      `, [`Publish error: ${err.message}`, post.id]);
      results.push({ id: post.id, status: 'failed', error: err.message });
    }
  }

  res.json({ processed: results.length, results });
});

// ── Cron: AI auto-generate 3 drafts (weekly) ──────────────────

router.post('/cron/auto-generate', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.body?.secret;
  if (secret !== process.env.CRON_SECRET && process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const db = getDb();

    // Only auto-generate if no drafts pending review
    const pendingDrafts = await db.get(
      "SELECT COUNT(*) as cnt FROM facebook_posts WHERE status = 'draft'",
    );
    if (pendingDrafts?.cnt > 3) {
      return res.json({ skipped: true, reason: 'Already has pending drafts' });
    }

    // Simulate hitting our own generate endpoint logic
    const topPosts = await db.all(`
      SELECT content, performance_score FROM facebook_posts
      WHERE status='published' AND performance_score > 0
      ORDER BY performance_score DESC LIMIT 3
    `);

    const perfContext = topPosts.length > 0
      ? `\n\nโพสที่ได้ผลดีก่อนหน้า:\n${topPosts.map(p => `Score ${p.performance_score.toFixed(1)}: "${p.content.slice(0, 80)}..."`).join('\n')}`
      : '';

    const prompt = `คุณคือ Social Media Manager ของ MeowChat — AI Chatbot สำหรับ LINE OA ช่วยธุรกิจไทย SME ตอบแชทอัตโนมัติ

สร้าง 3 โพส Facebook สำหรับสัปดาห์นี้ให้หลากหลาย:
1. โพสให้ความรู้/เคล็ดลับธุรกิจ (เกี่ยวกับ chatbot/LINE OA/ลูกค้า)
2. โพส social proof หรือ use case จากร้านค้า
3. โพส offer/CTA (ทดลองฟรี)
${perfContext}

กฎ: ภาษาไทย เป็นกันเอง hook ดึงดูด 100-200 คำ ไม่เกิน 5 emoji

ตอบ JSON array เท่านั้น:
[{ "title": "...", "content": "...", "notes": "..." }, ...]`;

    const raw = await generateWithGemini(prompt);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('AI response not parseable');
    const drafts = JSON.parse(match[0]);

    const saved = [];
    for (const d of drafts) {
      const row = await db.get(`
        INSERT INTO facebook_posts (title, content, notes, source, status)
        VALUES ($1, $2, $3, 'ai-auto', 'draft') RETURNING *
      `, [d.title || null, d.content, d.notes || null]);
      saved.push(row);
    }

    res.json({ generated: saved.length, posts: saved });
  } catch (err) {
    console.error('[fb] auto-generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Analytics dashboard ────────────────────────────────────────

router.get('/stats/summary', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const [totals, byStatus, topPost] = await Promise.all([
      db.get(`SELECT COUNT(*) as total,
        SUM(likes) as total_likes, SUM(shares) as total_shares,
        SUM(reach) as total_reach, AVG(performance_score) as avg_score
        FROM facebook_posts WHERE status='published'`),
      db.all(`SELECT status, COUNT(*) as count FROM facebook_posts GROUP BY status`),
      db.get(`SELECT * FROM facebook_posts WHERE status='published'
        ORDER BY performance_score DESC LIMIT 1`),
    ]);
    res.json({ totals, byStatus, topPost });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
