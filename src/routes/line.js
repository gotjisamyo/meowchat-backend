const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { getDb } = require('../db');
const { updateUsage } = require('./billing');
const { pushToLine } = require('../utils/line-push');

const router = express.Router();

// ─── LINE helpers ──────────────────────────────────────────────────────────────

function verifyLineSignature(rawBody, signature, channelSecret) {
  const hmac = crypto.createHmac('sha256', channelSecret);
  hmac.update(rawBody);
  const expected = hmac.digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function replyToLine(replyToken, text, accessToken) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    { replyToken, messages: [{ type: 'text', text }] },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } }
  ).catch(err => console.error('[LINE reply error]', err.response?.data || err.message));
}

// ─── Escalation detection (mirrored from engine/guardrails.ts) ─────────────────

const ESCALATION_PATTERNS = [
  /คืนเงิน|refund|เงินคืน/i,
  /โกง|ปลอม|หลอก|ฉ้อโกง/i,
  /คุยกับคน|คุยกับพนักงาน|human|เจ้าหน้าที่|ผู้จัดการ|manager/i,
  /แจ้งความ|ฟ้อง|ร้องเรียน|สคบ\./i,
  /ด่า|แย่มาก|ห่วยมาก|ไม่พอใจมาก/i,
];

function isEscalation(text) {
  return ESCALATION_PATTERNS.some(p => p.test(text));
}

// ─── Gemini inline call ────────────────────────────────────────────────────────

async function callGemini(userMessage, shop, products, knowledgeBase) {
  let shopInfo = {};
  try { shopInfo = JSON.parse(shop.description || '{}'); } catch {}

  let productList = '';
  if (products.length > 0) {
    productList = '\n\n📦 สินค้าของร้าน:\n' + products.map((p, i) =>
      `${i + 1}. ${p.name} - ฿${p.price}${p.stock > 0 ? ` (มี ${p.stock} ชิ้น)` : ' (หมด)'}${p.description ? ` - ${p.description}` : ''}`
    ).join('\n');
  }

  let kbText = '';
  if (knowledgeBase.length > 0) {
    kbText = '\n\n📚 ข้อมูลเพิ่มเติม:\n' + knowledgeBase.map(k =>
      `${k.topic}: ${k.content}`
    ).join('\n');
  }

  const systemPrompt = `คุณเป็น AI ผู้ช่วยขายของร้าน "${shop.name || 'ร้านค้า'}"
ประเภทธุรกิจ: ${shopInfo.businessType || 'ทั่วไป'}
${shopInfo.phone ? `โทร: ${shopInfo.phone}` : ''}${shopInfo.openHours ? ` เวลาเปิด: ${shopInfo.openHours}` : ''}
บุคลิก: ${shopInfo.botStyle || 'friendly'}
${shopInfo.aiCustomKnowledge ? `\nข้อมูลร้าน: ${shopInfo.aiCustomKnowledge}` : ''}${productList}${kbText}

ตอบภาษาไทย กระชับ เป็นมิตร ไม่เกิน 3-4 ประโยค อย่าเดาราคาหรือสต็อกที่ไม่มีในข้อมูล`;

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: systemPrompt + '\n\nUser: ' + userMessage }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
    }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return text || 'ขออภัยค่ะ ไม่สามารถตอบได้ในขณะนี้ กรุณาลองใหม่อีกครั้งนะคะ';
}

// ─── Engine routing (forward to meowchat-engine) ──────────────────────────────

const ENGINE_URL = process.env.ENGINE_URL || 'https://meowchat-engine-production.up.railway.app';
const ENGINE_ADMIN_KEY = process.env.ENGINE_ADMIN_KEY || '';

function buildBotConfig(shop, products, knowledgeBase) {
  let shopInfo = {};
  try { shopInfo = JSON.parse(shop.description || '{}'); } catch {}

  const personalityMap = { friendly: 'friendly', formal: 'formal', sales: 'sales', cute: 'cute' };
  const personalityMode = personalityMap[shopInfo.botStyle] || 'friendly';

  const kbEntries = [
    ...products.map((p) => ({
      id: `product-${p.name}`,
      topic: 'สินค้า',
      content: `${p.name} ราคา ฿${p.price}${p.stock > 0 ? ` มี ${p.stock} ชิ้น` : ' หมดแล้ว'}${p.description ? ` — ${p.description}` : ''}`,
      keywords: [p.name],
    })),
    ...knowledgeBase.map((k, i) => ({
      id: `kb-${i}`,
      topic: k.topic,
      content: k.content,
      keywords: typeof k.keywords === 'string'
        ? JSON.parse(k.keywords || '[]')
        : (Array.isArray(k.keywords) ? k.keywords : [k.topic]),
    })),
  ];

  return {
    botId: String(shop.id),
    botName: shopInfo.botName || shop.name || 'MeowChat Bot',
    businessName: shop.name || '',
    personalityMode,
    businessScope: shopInfo.businessScope || [],
    lineChannelSecret: shop.line_channel_secret,
    lineChannelAccessToken: shop.line_access_token,
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    model: 'gemini-2.0-flash',
    knowledgeBase: kbEntries,
    showBranding: true,
    subscriptionStatus: shop.subscription_status || 'trial',
    escalationKeywords: shopInfo.escalationKeywords || [],
  };
}

async function registerBotInEngine(config) {
  await axios.post(`${ENGINE_URL}/admin/bots`, config, {
    headers: { 'x-admin-key': ENGINE_ADMIN_KEY, 'Content-Type': 'application/json' },
    timeout: 5000,
  });
}

async function callEngine(userMessage, shop, products, knowledgeBase) {
  if (!ENGINE_ADMIN_KEY) throw new Error('ENGINE_ADMIN_KEY not set');
  const botId = String(shop.id);
  const payload = { message: userMessage };
  const headers = { 'x-admin-key': ENGINE_ADMIN_KEY, 'Content-Type': 'application/json' };

  try {
    const resp = await axios.post(`${ENGINE_URL}/admin/bots/${botId}/simulate`, payload, { headers, timeout: 10000 });
    return resp.data?.reply || null;
  } catch (err) {
    // Bot not registered yet — auto-register and retry once
    if (err.response?.status === 404) {
      console.log(`[engine] bot not found, registering shopId=${botId}`);
      const config = buildBotConfig(shop, products, knowledgeBase);
      await registerBotInEngine(config);
      const resp = await axios.post(`${ENGINE_URL}/admin/bots/${botId}/simulate`, payload, { headers, timeout: 10000 });
      return resp.data?.reply || null;
    }
    throw err;
  }
}

// ─── Conversation history ──────────────────────────────────────────────────────

async function saveConversationTurn(shopId, lineUserId, userText, botReply, escalated) {
  const db = getDb();

  // Find open conversation (last 24h) or create new
  let conv = await db.get(
    `SELECT id FROM conversations
     WHERE shop_id = ? AND line_user_id = ? AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY created_at DESC LIMIT 1`,
    [shopId, lineUserId]
  );

  if (!conv) {
    const result = await db.run(
      `INSERT INTO conversations (shop_id, line_user_id, escalated, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
      [shopId, lineUserId, escalated ? 1 : 0]
    );
    conv = { id: result.lastInsertRowid };
  } else {
    await db.run(
      `UPDATE conversations
       SET updated_at = CURRENT_TIMESTAMP${escalated ? ', escalated = 1' : ''}
       WHERE id = ?`,
      [conv.id]
    );
  }

  await db.run(
    `INSERT INTO conversation_messages (conversation_id, role, content, created_at)
     VALUES (?, 'user', ?, CURRENT_TIMESTAMP)`,
    [conv.id, userText]
  );
  await db.run(
    `INSERT INTO conversation_messages (conversation_id, role, content, created_at)
     VALUES (?, 'assistant', ?, CURRENT_TIMESTAMP)`,
    [conv.id, botReply]
  );
}

// ─── Process a single LINE event ──────────────────────────────────────────────

async function processEvent(event, shop, products, knowledgeBase) {
  if (event.type !== 'message' || event.message?.type !== 'text') return;

  const userId = event.source?.userId;
  const replyToken = event.replyToken;
  const userText = event.message.text?.trim();

  if (!userId || !replyToken || !userText) return;

  // Check if message matches active pairing code
  {
    const db = getDb();
    const shopRecord = await db.get(
      `SELECT pairing_code FROM shops WHERE id = ? AND pairing_code_expires_at > datetime('now')`,
      [shop.id]
    );
    if (shopRecord?.pairing_code && userText.trim().toUpperCase() === shopRecord.pairing_code) {
      await db.run(
        `UPDATE shops SET owner_line_user_id = ?, pairing_code = NULL, pairing_code_expires_at = NULL WHERE id = ?`,
        [userId, shop.id]
      );
      await replyToLine(replyToken, '✅ เชื่อมต่อสำเร็จ! คุณจะได้รับแจ้งเตือน Handoff ทาง LINE นี้ค่ะ', shop.line_access_token);
      return; // Do NOT pass to AI
    }
  }

  const escalated = isEscalation(userText);

  let reply;
  if (escalated) {
    reply = `ขอโทษที่ทำให้ไม่สะดวกนะคะ ทางร้านจะให้ทีมงานติดต่อกลับโดยเร็วที่สุดนะคะ ขอบคุณที่รอค่ะ 🙏`;

    // Look up customer name: DB first, then LINE profile API, then userId fallback
    const db = getDb();
    let customerName = null;
    const existing = await db.get(
      'SELECT name FROM customers WHERE shop_id = ? AND line_user_id = ? LIMIT 1',
      [shop.id, userId]
    ).catch(() => null);
    if (existing?.name) {
      customerName = existing.name;
    } else if (shop.line_access_token) {
      try {
        const profile = await axios.get(`https://api.line.me/v2/profile/${userId}`, {
          headers: { Authorization: `Bearer ${shop.line_access_token}` },
          timeout: 3000,
        });
        customerName = profile.data.displayName || null;
      } catch {}
    }

    // Save handoff record
    const handoffId = crypto.randomUUID();
    await db.run(
      `INSERT INTO handoffs (id, shop_id, line_user_id, customer_name, message, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [handoffId, shop.id, userId, customerName, userText]
    ).catch(e => console.error('[handoff save error]', e.message));

    // Push LINE notification to merchant if they have paired their LINE
    const shopForNotify = await db.get(
      'SELECT owner_line_user_id, line_access_token FROM shops WHERE id = ?',
      [shop.id]
    ).catch(() => null);
    if (shopForNotify?.owner_line_user_id && shopForNotify?.line_access_token) {
      pushToLine(
        shopForNotify.owner_line_user_id,
        `🔔 ลูกค้าขอคุยกับพนักงาน!\nลูกค้า: ${customerName || userId}\nข้อความ: "${userText}"\n\n👉 my.meowchat.store`,
        shopForNotify.line_access_token
      );
    }
    console.log(`[LINE] escalation detected shopId=${shop.id} userId=${userId}`);
  } else if (process.env.GEMINI_API_KEY || ENGINE_ADMIN_KEY) {
    try {
      // Try engine first (richer context: memory, vectors, personality)
      if (ENGINE_ADMIN_KEY) {
        reply = await callEngine(userText, shop, products, knowledgeBase);
        console.log(`[engine] replied shopId=${shop.id}`);
      }
      // Fallback to direct Gemini if engine unavailable
      if (!reply && process.env.GEMINI_API_KEY) {
        reply = await callGemini(userText, shop, products, knowledgeBase);
      }
    } catch (err) {
      console.error('[AI error]', err.response?.data || err.message);
      // Last-resort: direct Gemini
      if (process.env.GEMINI_API_KEY) {
        try { reply = await callGemini(userText, shop, products, knowledgeBase); } catch {}
      }
      if (!reply) reply = 'ขออภัยค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งนะคะ 💕';
    }
  } else {
    reply = `สวัสดีครับ! ได้รับข้อความของคุณแล้วค่ะ มีอะไรให้ช่วยไหมนะคะ? 😊`;
  }

  // Reply to customer
  await replyToLine(replyToken, reply, shop.line_access_token);

  // Task 3: Save conversation history
  await saveConversationTurn(shop.id, userId, userText, reply, escalated).catch(err =>
    console.error('[conversation save error]', err.message)
  );

  // Track usage
  await updateUsage(shop.id, 'chat', 1).catch(() => {});
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/line/webhook/:shopId — LINE platform verify probe
router.get('/:shopId', (req, res) => {
  res.json({ ok: true });
});

// POST /api/line/webhook/:shopId — main per-shop webhook
router.post('/:shopId', async (req, res) => {
  const { shopId } = req.params;
  const rawBody = req.rawBody;
  const signature = req.headers['x-line-signature'];

  if (!rawBody || !signature) {
    return res.status(400).json({ error: 'Missing body or signature' });
  }

  // Load shop
  const db = getDb();
  const shop = await db.get(
    `SELECT id, name, description, line_access_token, line_channel_secret, line_channel_id,
            line_notify_token, bot_locked, subscription_status
     FROM shops WHERE id = ?`,
    [shopId]
  ).catch(() => null);

  if (!shop || !shop.line_channel_secret || !shop.line_access_token) {
    return res.status(404).json({ error: 'Shop not found or LINE not configured' });
  }

  // Verify LINE signature
  if (!verifyLineSignature(rawBody.toString(), signature, shop.line_channel_secret)) {
    console.warn(`[LINE] invalid signature shopId=${shopId}`);
    return res.json({ ok: true }); // Return 200 to LINE — never reveal rejection
  }

  // Respond to LINE immediately (must be < 1s)
  res.json({ ok: true });

  // Skip processing if bot is locked (expired subscription)
  if (shop.bot_locked) {
    console.log(`[LINE] bot locked — skipping shopId=${shopId}`);
    return;
  }

  // Load context async (after responding to LINE)
  const [products, knowledgeBase] = await Promise.all([
    db.all(
      `SELECT name, price, description, stock FROM products WHERE shop_id = ? AND status = 'active' LIMIT 20`,
      [shopId]
    ).catch(() => []),
    db.all(
      `SELECT topic, content, keywords FROM bot_knowledge WHERE shop_id = ? ORDER BY "createdAt" ASC LIMIT 10`,
      [shopId]
    ).catch(() => [])
  ]);

  const events = req.body.events || [];
  await Promise.allSettled(
    events.map(event => processEvent(event, shop, products, knowledgeBase))
  );
});

module.exports = router;
