const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { getDb } = require('../db');
const { updateUsage } = require('./billing');

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
  );
}

async function pushToLine(userId, text, accessToken) {
  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to: userId, messages: [{ type: 'text', text }] },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } }
  ).catch(err => console.error('[LINE push error]', err.response?.data || err.message));
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

  const escalated = isEscalation(userText);

  let reply;
  if (escalated) {
    reply = `ขอโทษที่ทำให้ไม่สะดวกนะคะ ทางร้านจะให้ทีมงานติดต่อกลับโดยเร็วที่สุดนะคะ ขอบคุณที่รอค่ะ 🙏`;

    // Notify merchant via LINE Notify (line_notify_token = merchant's token, not channel ID)
    if (shop.line_notify_token) {
      const notifyText = `\n🔔 ลูกค้าต้องการความช่วยเหลือ!\nข้อความ: "${userText}"\n\nตอบกลับที่ my.meowchat.store/handoff`;
      fetch('https://notify-api.line.me/api/notify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${shop.line_notify_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ message: notifyText }),
      }).catch(e => console.warn('[LINE] notify failed:', e.message));
    }
    console.log(`[LINE] escalation detected shopId=${shop.id} userId=${userId}`);
  } else if (process.env.GEMINI_API_KEY) {
    try {
      reply = await callGemini(userText, shop, products, knowledgeBase);
    } catch (err) {
      console.error('[Gemini error]', err.response?.data || err.message);
      reply = 'ขออภัยค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งนะคะ 💕';
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
      `SELECT topic, content FROM bot_knowledge WHERE shop_id = ? ORDER BY "createdAt" ASC LIMIT 10`,
      [shopId]
    ).catch(() => [])
  ]);

  const events = req.body.events || [];
  await Promise.allSettled(
    events.map(event => processEvent(event, shop, products, knowledgeBase))
  );
});

module.exports = router;
