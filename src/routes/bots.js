const express = require('express');
const { getDb } = require('../db');
const https = require('https');
const crypto = require('crypto');
const axios = require('axios');

const router = express.Router();

// Helper: send LINE push message
async function sendLinePushMessage(accessToken, userId, message) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      {
        to: userId,
        messages: [{ type: 'text', text: message }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    return true;
  } catch (err) {
    console.error('LINE push error:', err.response?.data || err.message);
    return false;
  }
}

// Helper: generate shop ID
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// POST /api/bots/setup — save onboarding data (create shop + bot record)
router.post('/setup', async (req, res) => {
  try {
    const {
      businessType,
      shopName,
      phone,
      openHours,
      botName,
      botStyle,
      lineChannelToken,
      lineChannelSecret
    } = req.body;

    if (!shopName) {
      return res.status(400).json({ error: 'shopName is required' });
    }

    const db = getDb();
    const shopId = generateId();

    // Check if user already has a shop (update) or create new one
    const existing = await db.get(
      'SELECT id FROM shops WHERE user_id = ? ORDER BY created_at ASC LIMIT 1',
      [req.userId]
    );

    if (existing) {
      // Update existing shop with onboarding data
      await db.run(`
        UPDATE shops
        SET name = ?,
            description = ?,
            line_access_token = COALESCE(?, line_access_token),
            line_channel_secret = COALESCE(?, line_channel_secret),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `, [
        botName || shopName,
        JSON.stringify({ businessType, shopName, phone, openHours, botStyle }),
        lineChannelToken || null,
        lineChannelSecret || null,
        existing.id,
        req.userId
      ]);

      return res.json({ success: true, botId: existing.id, shopId: existing.id });
    }

    // Create new shop record
    await db.run(`
      INSERT INTO shops (id, user_id, name, description, line_access_token, line_channel_secret, plan, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'free', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      shopId,
      req.userId,
      botName || shopName,
      JSON.stringify({ businessType, shopName, phone, openHours, botStyle }),
      lineChannelToken || '',
      lineChannelSecret || ''
    ]);

    res.json({ success: true, botId: shopId, shopId });
  } catch (error) {
    console.error('Bot setup error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด: ' + error.message });
  }
});

// POST /api/bots/line-test — verify LINE channel credentials
router.post('/line-test', async (req, res) => {
  try {
    const { channelAccessToken, channelSecret } = req.body;

    if (!channelAccessToken) {
      return res.status(400).json({ success: false, error: 'channelAccessToken is required' });
    }

    // Call LINE API to verify token
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.line.me',
        path: '/v2/bot/info',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${channelAccessToken}`
        }
      };

      const request = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            resolve({ statusCode: response.statusCode, body: JSON.parse(data) });
          } catch (e) {
            resolve({ statusCode: response.statusCode, body: {} });
          }
        });
      });

      request.on('error', reject);
      request.end();
    });

    if (result.statusCode === 200) {
      return res.json({
        success: true,
        botName: result.body.displayName || '',
        botPicture: result.body.pictureUrl || ''
      });
    } else {
      return res.json({
        success: false,
        error: 'Invalid credentials',
        detail: result.body.message || 'Token ไม่ถูกต้อง'
      });
    }
  } catch (error) {
    console.error('LINE test error:', error);
    res.status(500).json({ success: false, error: 'Server error', message: error.message });
  }
});

// GET /api/bots — list all bots (shops) for current user
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const bots = await db.all(`
      SELECT s.id, s.name, s.description, s.line_channel_id, s.plan,
             s.created_at, s.updated_at,
             p.name as plan_name, p.max_chats, p.max_agents
      FROM shops s
      LEFT JOIN subscriptions sub ON s.id = sub.shop_id AND sub.status = 'active'
      LEFT JOIN plans p ON sub.plan_id = p.id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
    `, [req.userId]);

    res.json({ bots });
  } catch (error) {
    console.error('Get bots error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/bots/:id — get single bot by id
router.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const bot = await db.get(`
      SELECT s.id, s.name, s.description, s.line_channel_id, s.plan,
             s.created_at, s.updated_at,
             p.name as plan_name, p.max_chats, p.max_agents
      FROM shops s
      LEFT JOIN subscriptions sub ON s.id = sub.shop_id AND sub.status = 'active'
      LEFT JOIN plans p ON sub.plan_id = p.id
      WHERE s.id = ? AND s.user_id = ?
    `, [req.params.id, req.userId]);

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    res.json({ bot });
  } catch (error) {
    console.error('Get bot error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

// PUT /api/bots/:id — update bot settings (name, description/personality, greeting)
router.put('/:id', async (req, res) => {
  try {
    const { name, description, personality, greeting, aiPersonality, aiResponseStyle, aiCustomKnowledge } = req.body;
    const db = getDb();

    // Check ownership
    const existing = await db.get(
      'SELECT id FROM shops WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    );

    if (!existing) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    await db.run(`
      UPDATE shops
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `, [
      name || null,
      description || personality || null,
      req.params.id,
      req.userId
    ]);

    const bot = await db.get('SELECT * FROM shops WHERE id = ?', [req.params.id]);

    res.json({ message: 'อัปเดต bot สำเร็จ', bot });
  } catch (error) {
    console.error('Update bot error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/bots/:botId/conversations — list conversations for a bot
router.get('/:botId/conversations', async (req, res) => {
  try {
    const db = getDb();

    // Verify ownership
    const bot = await db.get(
      'SELECT id FROM shops WHERE id = ? AND user_id = ?',
      [req.params.botId, req.userId]
    );

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    // Fetch real conversations logged by engine (with message counts)
    const conversations = await db.all(`
      SELECT
        cv.id, cv.line_user_id, cv.customer_name as name,
        cv.status, cv.escalated,
        cv.created_at, cv.updated_at as last_message_at,
        COUNT(cm.id) as message_count,
        (SELECT cm2.content FROM conversation_messages cm2
         WHERE cm2.conversation_id = cv.id ORDER BY cm2.created_at DESC LIMIT 1) as last_message
      FROM conversations cv
      LEFT JOIN conversation_messages cm ON cm.conversation_id = cv.id
      WHERE cv.shop_id = ?
      GROUP BY cv.id
      ORDER BY cv.updated_at DESC
      LIMIT 100
    `, [req.params.botId]);

    res.json({ conversations, botId: req.params.botId });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

// POST /api/bots/:botId/handoff — request human handoff
router.post('/:botId/handoff', async (req, res) => {
  try {
    const db = getDb();
    const { botId } = req.params;
    const { customerName, lineUserId, message } = req.body;

    // Verify ownership
    const shop = await db.get(
      'SELECT id, name, line_access_token, line_channel_id FROM shops WHERE id = ? AND user_id = ?',
      [botId, req.userId]
    );

    if (!shop) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    // Create handoff record
    const handoffId = crypto.randomBytes(8).toString('hex');
    await db.run(`
      INSERT INTO handoffs (id, shop_id, line_user_id, customer_name, message, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [handoffId, botId, lineUserId || null, customerName || 'ลูกค้า', message || '']);

    // Send LINE push notification to bot owner if line_access_token + line_channel_id available
    if (shop.line_access_token && shop.line_channel_id) {
      const notifyMsg = `🔔 แจ้งเตือน: มีลูกค้าต้องการคุยกับคุณ!\n\nชื่อ: ${customerName || 'ลูกค้า'}\nร้าน: ${shop.name}\n${message ? `ข้อความ: ${message}` : ''}\n\nกรุณาตอบกลับลูกค้าโดยเร็ว`;
      await sendLinePushMessage(shop.line_access_token, shop.line_channel_id, notifyMsg);
    }

    res.json({
      success: true,
      handoffId,
      message: 'กำลังติดต่อเจ้าหน้าที่'
    });
  } catch (error) {
    console.error('Handoff error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด: ' + error.message });
  }
});

// GET /api/bots/:botId/handoffs — list pending handoff requests
router.get('/:botId/handoffs', async (req, res) => {
  try {
    const db = getDb();
    const { botId } = req.params;
    const { status } = req.query;

    // Verify ownership
    const bot = await db.get(
      'SELECT id FROM shops WHERE id = ? AND user_id = ?',
      [botId, req.userId]
    );

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    const statusFilter = status || 'pending';
    const handoffs = await db.all(`
      SELECT h.id, h.shop_id, h.line_user_id, h.customer_name, h.message,
             h.status, h.resolved_at, h.created_at, h.updated_at
      FROM handoffs h
      WHERE h.shop_id = ? AND h.status = ?
      ORDER BY h.created_at DESC
      LIMIT 50
    `, [botId, statusFilter]);

    res.json({ handoffs, botId, status: statusFilter });
  } catch (error) {
    console.error('Get handoffs error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

// PATCH /api/bots/:botId/handoffs/:handoffId — resolve a handoff
router.patch('/:botId/handoffs/:handoffId', async (req, res) => {
  try {
    const db = getDb();
    const { botId, handoffId } = req.params;

    const bot = await db.get(
      'SELECT id FROM shops WHERE id = ? AND user_id = ?',
      [botId, req.userId]
    );

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    await db.run(`
      UPDATE handoffs
      SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND shop_id = ?
    `, [handoffId, botId]);

    res.json({ success: true, message: 'Handoff resolved' });
  } catch (error) {
    console.error('Resolve handoff error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

// POST /api/bots/:botId/simulate — test bot without going through LINE
router.post('/:botId/simulate', async (req, res) => {
  try {
    const db = getDb();
    const { botId } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Verify ownership
    const shop = await db.get(
      'SELECT id, name, description FROM shops WHERE id = ? AND user_id = ?',
      [botId, req.userId]
    );

    if (!shop) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    // Parse shop description for business info
    let shopInfo = {};
    try {
      shopInfo = JSON.parse(shop.description || '{}');
    } catch (e) {
      shopInfo = {};
    }

    // Get products for context
    const products = await db.all(
      "SELECT name, price, description, stock FROM products WHERE shop_id = ? AND status = 'active' LIMIT 20",
      [botId]
    );

    let productList = '';
    if (products && products.length > 0) {
      productList = '\n\n📦 สินค้าของร้าน:\n' + products.map((p, i) =>
        `${i + 1}. ${p.name} - ฿${p.price}${p.stock > 0 ? ` (มี ${p.stock} ชิ้น)` : ' (หมด)'}${p.description ? ` - ${p.description}` : ''}`
      ).join('\n');
    }

    // If Gemini API key available — use it
    if (process.env.GEMINI_API_KEY) {
      try {
        const systemPrompt = `คุณเป็น AI ผู้ช่วยของร้าน "${shop.name || 'ร้านค้า'}"
ประเภทธุรกิจ: ${shopInfo.businessType || 'ทั่วไป'}
ข้อมูลร้าน: ${shopInfo.shopName || shop.name || ''} ${shopInfo.phone ? `โทร: ${shopInfo.phone}` : ''} ${shopInfo.openHours ? `เวลาเปิด: ${shopInfo.openHours}` : ''}
บุคลิก: ${shopInfo.botStyle || 'friendly'}
${shopInfo.aiCustomKnowledge ? `ข้อมูลเพิ่มเติม: ${shopInfo.aiCustomKnowledge}` : ''}
${productList}

ตอบภาษาไทย กระชับ เป็นมิตร ไม่เกิน 3-4 ประโยค`;

        const geminiRes = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            contents: [{ parts: [{ text: systemPrompt + '\n\nUser: ' + message }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
          }
        );

        const reply = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (reply) {
          return res.json({ reply, source: 'ai' });
        }
      } catch (geminiErr) {
        console.error('Gemini simulate error:', geminiErr.response?.data || geminiErr.message);
      }
    }

    // Fallback: mock reply using shop info
    const shopName = shopInfo.shopName || shop.name || 'ร้านค้า';
    const greet = `สวัสดีครับ! ยินดีต้อนรับสู่ ${shopName} 😊`;
    let mockReply = greet;

    if (products && products.length > 0) {
      mockReply += `\n\nเรามีสินค้าให้เลือก ${products.length} รายการ เช่น ${products.slice(0, 3).map(p => p.name).join(', ')} มีอะไรให้ช่วยไหมครับ?`;
    } else {
      mockReply += '\n\nมีอะไรให้ช่วยไหมครับ? สอบถามข้อมูลสินค้าหรือบริการได้เลยนะครับ 🙏';
    }

    res.json({ reply: mockReply, source: 'mock' });
  } catch (error) {
    console.error('Simulate error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด: ' + error.message });
  }
});

// ── Knowledge Base CRUD ──────────────────────────────────────────────────────

router.get('/:botId/knowledge', async (req, res) => {
  try {
    const db = await getDb();
    const shop = await db.get('SELECT id FROM shops WHERE id = ? AND user_id = ?', [req.params.botId, req.user.id]);
    const shopId = shop?.id || req.params.botId;
    const rows = await db.all('SELECT * FROM bot_knowledge WHERE shop_id = ? ORDER BY "createdAt" ASC', [shopId]);
    res.json(rows.map(r => ({ ...r, keywords: JSON.parse(r.keywords || '[]') })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:botId/knowledge', async (req, res) => {
  try {
    const db = await getDb();
    const { topic, content, keywords = [] } = req.body;
    const id = `kb_${Date.now()}`;
    await db.run(
      'INSERT INTO bot_knowledge (id, shop_id, topic, content, keywords) VALUES (?, ?, ?, ?, ?)',
      [id, req.params.botId, topic, content, JSON.stringify(keywords)]
    );
    const entry = { id, topic, content, keywords };
    // Sync KB to engine (non-blocking)
    syncKBToEngine(req.params.botId, db).catch(e => console.warn('[bots] KB sync failed:', e));
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:botId/knowledge/:entryId', async (req, res) => {
  try {
    const db = await getDb();
    const { topic, content, keywords = [] } = req.body;
    await db.run(
      'UPDATE bot_knowledge SET topic = ?, content = ?, keywords = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ? AND shop_id = ?',
      [topic, content, JSON.stringify(keywords), req.params.entryId, req.params.botId]
    );
    // Sync KB to engine (non-blocking)
    syncKBToEngine(req.params.botId, db).catch(e => console.warn('[bots] KB sync failed:', e));
    res.json({ id: req.params.entryId, topic, content, keywords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:botId/knowledge/:entryId', async (req, res) => {
  try {
    const db = await getDb();
    await db.run('DELETE FROM bot_knowledge WHERE id = ? AND shop_id = ?', [req.params.entryId, req.params.botId]);
    // Sync KB to engine (non-blocking)
    syncKBToEngine(req.params.botId, db).catch(e => console.warn('[bots] KB sync failed:', e));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── KB sync helper: push KB to meowchat-engine ────────────────────────────────
async function syncKBToEngine(shopId, db) {
  const engineUrl = process.env.ENGINE_URL;
  const engineKey = process.env.ENGINE_ADMIN_KEY;
  if (!engineUrl || !engineKey) return;

  // 1. Fetch current bot config from engine
  const configRes = await fetch(`${engineUrl}/admin/bots/${shopId}`, {
    headers: { 'x-admin-key': engineKey }
  });
  if (!configRes.ok) return; // bot not registered in engine yet

  const config = await configRes.json();

  // 2. Load KB from DB
  const rows = await db.all(
    'SELECT * FROM bot_knowledge WHERE shop_id = ? ORDER BY "createdAt" ASC',
    [shopId]
  );
  const knowledgeBase = rows.map(r => ({
    id: r.id,
    topic: r.topic,
    content: r.content,
    keywords: JSON.parse(r.keywords || '[]'),
  }));

  // 3. Push updated config back to engine
  await fetch(`${engineUrl}/admin/bots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': engineKey },
    body: JSON.stringify({ ...config, knowledgeBase }),
  });

  console.log(`[bots] KB synced to engine: shopId=${shopId}, entries=${knowledgeBase.length}`);
}

module.exports = router;
