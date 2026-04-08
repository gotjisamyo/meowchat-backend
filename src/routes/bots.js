const express = require('express');
const { getDb } = require('../db');
const { trackEvent, EVENTS } = require('../events');
const https = require('https');
const crypto = require('crypto');
const axios = require('axios');

const router = express.Router();

// Strip HTML tags to prevent XSS from being stored in the DB
function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
}


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
      lineChannelId,
      lineChannelToken,
      lineChannelSecret
    } = req.body;

    if (!shopName) {
      return res.status(400).json({ error: 'shopName is required' });
    }

    const safeShopName = stripHtml(shopName);
    const safeBotName = botName ? stripHtml(botName) : null;

    const db = getDb();
    const shopId = generateId();

    // Trial abuse: if a LINE Channel ID is provided, ensure it hasn't claimed a trial before
    if (lineChannelId && lineChannelId.trim()) {
      const existingTrial = await db.get(
        'SELECT line_channel_id, shop_id FROM line_channel_trials WHERE line_channel_id = ?',
        [lineChannelId.trim()]
      );
      if (existingTrial) {
        return res.status(409).json({
          error: 'Trial already used',
          message: 'LINE OA นี้เคยใช้สิทธิ์ทดลองฟรีแล้ว กรุณาเลือกแผนที่เหมาะสม',
          redirect: '/pricing'
        });
      }
    }

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
            line_channel_id = COALESCE(?, line_channel_id),
            line_access_token = COALESCE(?, line_access_token),
            line_channel_secret = COALESCE(?, line_channel_secret),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `, [
        safeBotName || safeShopName,
        JSON.stringify({ businessType, shopName: safeShopName, phone, openHours, botStyle }),
        lineChannelId ? lineChannelId.trim() : null,
        lineChannelToken || null,
        lineChannelSecret || null,
        existing.id,
        req.userId
      ]);

      // Track bot_activated if LINE token was provided in this update
      if (lineChannelToken) {
        trackEvent(existing.id, EVENTS.BOT_ACTIVATED).catch(() => {});
      }
      // Re-sync bot config to engine (non-blocking)
      syncBotToEngine(existing.id, db).catch(e => console.warn('[bots] engine sync failed:', e));
      return res.json({ success: true, botId: existing.id, shopId: existing.id });
    }

    // Create new shop record
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    await db.run(`
      INSERT INTO shops (id, user_id, name, description, line_channel_id, line_access_token, line_channel_secret, plan, trial_ends_at, subscription_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'trial', ?, 'trial', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      shopId,
      req.userId,
      safeBotName || safeShopName,
      JSON.stringify({ businessType, shopName: safeShopName, phone, openHours, botStyle }),
      lineChannelId ? lineChannelId.trim() : '',
      lineChannelToken || '',
      lineChannelSecret || '',
      trialEndsAt
    ]);

    // Record LINE Channel ID as trial-used to prevent abuse
    if (lineChannelId && lineChannelId.trim()) {
      try {
        await db.run(
          `INSERT INTO line_channel_trials (line_channel_id, shop_id, user_id)
           VALUES (?, ?, ?)
           ON CONFLICT (line_channel_id) DO NOTHING`,
          [lineChannelId.trim(), shopId, req.userId]
        );
      } catch (trialErr) {
        console.error('Record trial error (non-fatal):', trialErr.message);
      }
    }

    // Create trial subscription record
    try {
      await db.run(`
        INSERT INTO subscriptions (shop_id, plan_id, status, payment_method, payment_status)
        VALUES (?, 1, 'trial', 'free', 'paid')
      `, [shopId]);
    } catch (subErr) {
      console.error('Create trial subscription error (non-fatal):', subErr.message);
    }

    // Track trial_started on new shop creation
    trackEvent(shopId, EVENTS.TRIAL_STARTED).catch(() => {});
    // Track bot_activated if LINE token provided
    if (lineChannelToken) {
      trackEvent(shopId, EVENTS.BOT_ACTIVATED).catch(() => {});
    }

    // Register bot in engine (non-blocking)
    syncBotToEngine(shopId, db).catch(e => console.warn('[bots] engine sync failed:', e));

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
             s.line_notify_token,
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

    const { line_notify_token, line_access_token, line_channel_secret, slip_verify_mode } = req.body;
    const allowedSlipModes = ['off', 'auto', 'manual'];
    const slipMode = slip_verify_mode && allowedSlipModes.includes(slip_verify_mode) ? slip_verify_mode : null;

    // Guard token field lengths (LINE tokens are ~172 chars; cap at 512 to prevent DB abuse)
    const MAX_TOKEN_LEN = 512;
    if (line_notify_token && String(line_notify_token).length > MAX_TOKEN_LEN) {
      return res.status(400).json({ error: 'line_notify_token too long' });
    }
    if (line_access_token && String(line_access_token).length > MAX_TOKEN_LEN) {
      return res.status(400).json({ error: 'line_access_token too long' });
    }
    if (line_channel_secret && String(line_channel_secret).length > MAX_TOKEN_LEN) {
      return res.status(400).json({ error: 'line_channel_secret too long' });
    }
    await db.run(`
      UPDATE shops
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          line_notify_token = COALESCE(?, line_notify_token),
          line_access_token = COALESCE(?, line_access_token),
          line_channel_secret = COALESCE(?, line_channel_secret),
          slip_verify_mode = COALESCE(?, slip_verify_mode),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `, [
      name ? stripHtml(name) : null,
      (description || personality) ? stripHtml(description || personality) : null,
      line_notify_token !== undefined ? line_notify_token : null,
      line_access_token || null,
      line_channel_secret || null,
      slipMode,
      req.params.id,
      req.userId
    ]);

    const bot = await db.get('SELECT * FROM shops WHERE id = ?', [req.params.id]);

    // Re-sync full bot config to engine whenever settings change
    syncBotToEngine(req.params.id, db).catch(e => console.warn('[bots] engine sync failed:', e));

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

// GET /api/bots/:botId/conversations/:convId/messages — message thread
router.get('/:botId/conversations/:convId/messages', async (req, res) => {
  try {
    const db = getDb();
    // Verify the conversation belongs to this bot AND the bot belongs to this user
    const conv = await db.get(
      `SELECT cv.id FROM conversations cv
       JOIN shops s ON s.id = cv.shop_id
       WHERE cv.id = ? AND cv.shop_id = ? AND s.user_id = ?`,
      [req.params.convId, req.params.botId, req.userId]
    );
    if (!conv) return res.status(403).json({ error: 'Access denied' });
    const messages = await db.all(
      `SELECT id, role, content, created_at FROM conversation_messages
       WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200`,
      [req.params.convId]
    );
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
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
      'SELECT id, name, line_access_token, line_channel_id, line_notify_token FROM shops WHERE id = ? AND user_id = ?',
      [botId, req.userId]
    );

    if (!shop) {
      return res.status(404).json({ error: 'Bot not found', message: 'ไม่พบ bot' });
    }

    // Create handoff record
    const handoffId = crypto.randomBytes(8).toString('hex');
    const safeCustomerName = stripHtml(String(customerName || 'ลูกค้า')).slice(0, 200);
    const safeMessage = stripHtml(String(message || '')).slice(0, 1000);
    await db.run(`
      INSERT INTO handoffs (id, shop_id, line_user_id, customer_name, message, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [handoffId, botId, lineUserId || null, safeCustomerName, safeMessage]);

    // Notify merchant via LINE Notify (correct — uses notify token, not channel ID)
    if (shop.line_notify_token) {
      const notifyMsg = `\n🔔 มีลูกค้าต้องการคุยกับคุณ!\nชื่อ: ${customerName || 'ลูกค้า'}\nร้าน: ${shop.name}${message ? `\nข้อความ: ${message}` : ''}\n\nกรุณาตอบกลับที่ my.meowchat.store/handoff`;
      fetch('https://notify-api.line.me/api/notify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${shop.line_notify_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ message: notifyMsg }),
      }).catch(e => console.warn('[handoff] LINE Notify failed:', e.message));
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
    if (message.length > 500) {
      return res.status(400).json({ error: 'message must be ≤ 500 characters for simulation' });
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

    // Get KB entries for context
    const kbEntries = await db.all(
      'SELECT topic, content FROM bot_knowledge WHERE shop_id = ? LIMIT 30',
      [botId]
    );
    let kbList = '';
    if (kbEntries && kbEntries.length > 0) {
      kbList = '\n\n📚 ข้อมูลร้าน (Knowledge Base):\n' + kbEntries.map(e =>
        `• ${e.topic}: ${e.content}`
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
${productList}${kbList}

ตอบภาษาไทย กระชับ เป็นมิตร ไม่เกิน 3-4 ประโยค ใช้ข้อมูลจาก Knowledge Base เป็นหลัก`;

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

// Ownership guard: verify botId belongs to authenticated user
async function requireShopOwner(req, res, next) {
  try {
    const db = await getDb();
    const shop = await db.get(
      'SELECT id FROM shops WHERE id = ? AND user_id = ?',
      [req.params.botId, req.userId]
    );
    if (!shop) return res.status(403).json({ error: 'Access denied' });
    req.shopId = shop.id;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

router.get('/:botId/knowledge', requireShopOwner, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.all(
      'SELECT * FROM bot_knowledge WHERE shop_id = ? ORDER BY "createdAt" ASC',
      [req.shopId]
    );
    res.json(rows.map(r => ({ ...r, keywords: JSON.parse(r.keywords || '[]') })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:botId/knowledge', requireShopOwner, async (req, res) => {
  try {
    const { topic, content, keywords = [] } = req.body;
    if (!topic || !topic.trim()) return res.status(400).json({ error: 'topic is required' });
    if (!content || !content.trim()) return res.status(400).json({ error: 'content is required' });
    if (content.length > 5000) return res.status(400).json({ error: 'content must be ≤ 5000 chars' });
    const db = await getDb();
    const safeTopic = stripHtml(topic.trim());
    const safeContent = stripHtml(content.trim());
    const id = `kb_${crypto.randomBytes(8).toString('hex')}`;
    await db.run(
      'INSERT INTO bot_knowledge (id, shop_id, topic, content, keywords) VALUES (?, ?, ?, ?, ?)',
      [id, req.shopId, safeTopic, safeContent, JSON.stringify(keywords)]
    );
    const entry = { id, topic: safeTopic, content: safeContent, keywords };
    syncKBToEngine(req.shopId, db).catch(e => console.warn('[bots] KB sync failed:', e));
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:botId/knowledge/:entryId', requireShopOwner, async (req, res) => {
  try {
    const { topic, content, keywords = [] } = req.body;
    if (!topic || !topic.trim()) return res.status(400).json({ error: 'topic is required' });
    if (!content || !content.trim()) return res.status(400).json({ error: 'content is required' });
    if (content.length > 5000) return res.status(400).json({ error: 'content must be ≤ 5000 chars' });
    const db = await getDb();
    const safeTopic = stripHtml(topic.trim());
    const safeContent = stripHtml(content.trim());
    const result = await db.run(
      'UPDATE bot_knowledge SET topic = ?, content = ?, keywords = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ? AND shop_id = ?',
      [safeTopic, safeContent, JSON.stringify(keywords), req.params.entryId, req.shopId]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    syncKBToEngine(req.shopId, db).catch(e => console.warn('[bots] KB sync failed:', e));
    res.json({ id: req.params.entryId, topic: safeTopic, content: safeContent, keywords });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:botId/knowledge/:entryId', requireShopOwner, async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.run(
      'DELETE FROM bot_knowledge WHERE id = ? AND shop_id = ?',
      [req.params.entryId, req.shopId]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    syncKBToEngine(req.shopId, db).catch(e => console.warn('[bots] KB sync failed:', e));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Full bot sync to engine — register bot + push KB ──────────────────────────
async function syncBotToEngine(shopId, db) {
  const engineUrl = process.env.ENGINE_URL;
  const engineKey = process.env.ENGINE_ADMIN_KEY;
  if (!engineUrl || !engineKey) return;

  const shop = await db.get('SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!shop) return;

  let desc = {};
  try { desc = JSON.parse(shop.description || '{}'); } catch {}

  const rows = await db.all(
    'SELECT * FROM bot_knowledge WHERE shop_id = ? ORDER BY "createdAt" ASC',
    [shopId]
  );
  const knowledgeBase = rows.map(r => ({
    id: r.id,
    topic: r.topic,
    content: r.content,
    keywords: typeof r.keywords === 'string' ? JSON.parse(r.keywords || '[]') : (r.keywords || []),
  }));

  const config = {
    botId: shopId,
    botName: shop.name || 'MeowChat Bot',
    businessName: desc.shopName || shop.name || '',
    personalityMode: desc.botStyle || 'friendly',
    businessScope: [desc.openHours, desc.phone].filter(Boolean),
    lineChannelSecret: shop.line_channel_secret || '',
    lineChannelAccessToken: shop.line_access_token || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    model: 'gemini-2.0-flash',
    knowledgeBase,
    showBranding: shop.plan !== 'active',
    subscriptionStatus: shop.subscription_status || 'trial',
    botLocked: shop.bot_locked || false,
    slipVerifyMode: shop.slip_verify_mode || 'off',
    quickReplies: (() => { try { return JSON.parse(shop.quick_replies || '[]'); } catch { return []; } })(),
  };

  await fetch(`${engineUrl}/admin/bots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': engineKey },
    body: JSON.stringify(config),
  });

  console.log(`[bots] synced to engine: shopId=${shopId}, kb=${knowledgeBase.length} entries, lineToken=${shop.line_access_token ? 'SET' : 'EMPTY'}`);
}

// ── KB sync helper: update only KB in engine (bot must be registered) ──────────
async function syncKBToEngine(shopId, db) {
  // Now just delegates to full sync — simpler and always correct
  return syncBotToEngine(shopId, db);
}

// POST /api/bots/:botId/track-upgrade — called when merchant clicks Upgrade button
router.post('/:botId/track-upgrade', async (req, res) => {
  try {
    const db = getDb();
    const shop = await db.get('SELECT id FROM shops WHERE id = ? AND user_id = ?', [req.params.botId, req.userId]);
    if (!shop) return res.status(404).json({ error: 'Not found' });
    trackEvent(shop.id, EVENTS.UPGRADE_CLICKED).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bots/:botId/broadcast/recipients — count eligible recipients
router.get('/:botId/broadcast/recipients', async (req, res) => {
  try {
    const db = getDb();
    const shop = await db.get('SELECT id FROM shops WHERE id = ? AND user_id = ?', [req.params.botId, req.userId]);
    if (!shop) return res.status(404).json({ error: 'Not found' });
    const row = await db.get(
      'SELECT COUNT(DISTINCT line_user_id) as count FROM conversations WHERE shop_id = ?',
      [req.params.botId]
    );
    res.json({ count: Number(row?.count || 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bots/:botId/broadcast/history — list past broadcasts
router.get('/:botId/broadcast/history', async (req, res) => {
  try {
    const db = getDb();
    const shop = await db.get('SELECT id FROM shops WHERE id = ? AND user_id = ?', [req.params.botId, req.userId]);
    if (!shop) return res.status(404).json({ error: 'Not found' });
    const rows = await db.all(
      'SELECT * FROM broadcasts WHERE shop_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.params.botId]
    );
    res.json({ broadcasts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bots/:botId/broadcast — send broadcast to all LINE users
router.post('/:botId/broadcast', async (req, res) => {
  try {
    const db = getDb();
    const shop = await db.get('SELECT * FROM shops WHERE id = ? AND user_id = ?', [req.params.botId, req.userId]);
    if (!shop) return res.status(404).json({ error: 'Not found' });

    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });
    if (message.length > 2000) return res.status(400).json({ error: 'message must be ≤ 2000 chars (LINE limit)' });

    // Get all distinct LINE user IDs for this shop
    const users = await db.all(
      'SELECT DISTINCT line_user_id FROM conversations WHERE shop_id = ?',
      [req.params.botId]
    );
    const userIds = users.map(u => u.line_user_id).filter(Boolean);

    // Create broadcast record
    const result = await db.run(
      `INSERT INTO broadcasts (shop_id, message, recipient_count, status) VALUES (?, ?, ?, 'sending') RETURNING id`,
      [req.params.botId, message.trim(), userIds.length]
    );
    const broadcastId = result.lastInsertRowid;

    res.json({ ok: true, broadcastId, recipientCount: userIds.length });

    // Send in background — LINE Multicast (batch 500)
    const accessToken = shop.line_access_token;
    if (!accessToken || userIds.length === 0) {
      await db.run(`UPDATE broadcasts SET status = 'sent', sent_count = 0, sent_at = CURRENT_TIMESTAMP WHERE id = ?`, [broadcastId]);
      return;
    }

    let sentCount = 0;
    const BATCH = 500;
    for (let i = 0; i < userIds.length; i += BATCH) {
      const batch = userIds.slice(i, i + BATCH);
      try {
        const resp = await fetch('https://api.line.me/v2/bot/message/multicast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ to: batch, messages: [{ type: 'text', text: message.trim() }] }),
        });
        if (resp.ok) {
          sentCount += batch.length;
        } else {
          console.error(`[broadcast] LINE API error ${resp.status} for batch at index ${i}`);
        }
      } catch (e) {
        console.error('[broadcast] multicast batch error:', e.message);
      }
    }

    await db.run(
      `UPDATE broadcasts SET status = 'sent', sent_count = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [sentCount, broadcastId]
    );
    console.log(`[broadcast] shopId=${req.params.botId} sent=${sentCount}/${userIds.length}`);
  } catch (err) {
    console.error('[broadcast] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bots/:botId/quick-replies
router.get('/:botId/quick-replies', async (req, res) => {
  try {
    const db = getDb();
    const shop = await db.get('SELECT id, quick_replies FROM shops WHERE id = ? AND user_id = ?', [req.params.botId, req.userId]);
    if (!shop) return res.status(404).json({ error: 'Not found' });
    let items = [];
    try { items = JSON.parse(shop.quick_replies || '[]'); } catch {}
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/bots/:botId/quick-replies
router.put('/:botId/quick-replies', async (req, res) => {
  try {
    const db = getDb();
    const shop = await db.get('SELECT id FROM shops WHERE id = ? AND user_id = ?', [req.params.botId, req.userId]);
    if (!shop) return res.status(404).json({ error: 'Not found' });
    const items = (req.body.items || []).slice(0, 13).map(item => ({
      label: String(item.label || '').slice(0, 20),
      text: String(item.text || '').slice(0, 300),
    })).filter(item => item.label && item.text);
    await db.run('UPDATE shops SET quick_replies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(items), req.params.botId]);
    // Re-sync to engine
    syncBotToEngine(req.params.botId, db).catch(e => console.warn('[bots] engine sync failed:', e));
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bots/:botId/unanswered-questions
router.get('/:botId/unanswered-questions', async (req, res) => {
  try {
    const db = getDb();
    const shop = await db.get('SELECT id FROM shops WHERE id = ? AND user_id = ?', [req.params.botId, req.userId]);
    if (!shop) return res.status(404).json({ error: 'Not found' });

    // Find user messages from escalated conversations, grouped by content
    const rows = await db.all(`
      SELECT cm.content as text, COUNT(*) as count, MAX(cm.created_at) as lastAskedAt,
             MIN(cm.id) as id
      FROM conversation_messages cm
      JOIN conversations c ON cm.conversation_id = c.id
      WHERE c.shop_id = ? AND c.escalated = 1 AND cm.role = 'user'
      GROUP BY cm.content
      ORDER BY count DESC, lastAskedAt DESC
      LIMIT 50
    `, [req.params.botId]);

    const questions = rows.map(r => ({
      id: r.id,
      text: r.text,
      count: r.count,
      lastAskedAt: r.lastAskedAt
    }));

    res.json({ questions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// GEMINI_API_KEY env var added 1775060471
