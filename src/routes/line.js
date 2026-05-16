const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { getDb } = require('../db');
const { updateUsage } = require('./billing');
const { pushToLine } = require('../utils/line-push');
const { sendEscalationEmail } = require('../utils/email');

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

// ─── Order helpers ────────────────────────────────────────────────────────────

const CONFIRM_PATTERNS = /^(ใช่|ยืนยัน|confirm|yes|ตกลง|ok|โอเค|สั่งเลย|เอาเลย|ใช้เลย)$/i;
const CANCEL_PATTERNS  = /^(ไม่|ยกเลิก|cancel|no|ไม่เอา|ไม่สั่ง)$/i;

// Use Gemini to detect order intent and extract items
async function detectOrder(userMessage, products) {
  if (!process.env.GEMINI_API_KEY || products.length === 0) return null;

  const productList = products.map(p =>
    `id:${p.id}|name:${p.name}|price:${p.price}|stock:${p.stock ?? 999}`
  ).join('\n');

  const prompt = `สินค้าในร้าน:\n${productList}\n\nข้อความลูกค้า: "${userMessage}"\n\nลูกค้าต้องการสั่งสินค้าไหม? ถ้าใช่ให้ตอบ JSON เท่านั้น ถ้าไม่ใช่ให้ตอบ null เท่านั้น\n\nJSON format: [{"id":"product_id","name":"ชื่อ","qty":จำนวน,"price":ราคา}]\n\nอย่าตอบอะไรนอกจาก JSON array หรือ null`;

  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 256 } }
    );
    const raw = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    if (!raw || raw === 'null') return null;
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const items = JSON.parse(match[0]);
    if (!Array.isArray(items) || items.length === 0) return null;
    // Validate items against real products
    const validated = items.map(item => {
      const product = products.find(p =>
        p.id === item.id || p.name.toLowerCase() === (item.name || '').toLowerCase()
      );
      if (!product) return null;
      const qty = Math.max(1, parseInt(item.qty) || 1);
      const stock = product.stock ?? 999;
      if (stock < qty) return { ...item, productId: product.id, name: product.name, qty, price: Number(product.price), outOfStock: true };
      return { productId: product.id, name: product.name, qty, price: Number(product.price) };
    }).filter(Boolean);
    return validated.length > 0 ? validated : null;
  } catch (err) {
    console.error('[order-detect] error:', err.message);
    return null;
  }
}

// Create order directly from LINE (no auth middleware)
async function createInternalOrder(db, shopId, lineUserId, items) {
  const orderId = 'ord_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const orderNumber = 'ORD-' + Date.now();
  const now = new Date().toISOString();
  let total = 0;
  const orderItems = [];

  for (const item of items) {
    const inv = await db.get(
      'SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?',
      [shopId, item.productId]
    );
    const qty = item.qty;

    if (inv && inv.quantity >= qty) {
      await db.run(
        'UPDATE inventory SET quantity = quantity - ?, updated_at = ? WHERE id = ?',
        [qty, now, inv.id]
      );
      const movId = 'mov_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      await db.run(
        `INSERT INTO stock_movements (id,inventory_id,product_id,shop_id,type,quantity,reference,notes,created_by,created_at)
         VALUES (?,?,?,?,'out',?,?,?,'line_order',?)`,
        [movId, inv.id, item.productId, shopId, qty, orderNumber, `LINE ${lineUserId}`, now]
      );
      // Low stock alert
      const updated = await db.get('SELECT quantity, min_stock_level FROM inventory WHERE id = ?', [inv.id]);
      if (updated && updated.quantity <= (updated.min_stock_level || 0)) {
        const alertId = 'alert_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        await db.run(
          `INSERT INTO stock_alerts (id,shop_id,product_id,type,created_at) VALUES (?,?,?,?,?)
           ON CONFLICT (id) DO NOTHING`,
          [alertId, shopId, item.productId, updated.quantity <= 0 ? 'out_of_stock' : 'low_stock', now]
        );
      }
    }

    total += item.price * qty;
    orderItems.push({ productId: item.productId, productName: item.name, quantity: qty, price: item.price });
  }

  await db.run(
    `INSERT INTO orders (id,shop_id,order_number,status,items,total_amount,note,created_at,updated_at)
     VALUES (?,?,?,'pending',?,?,?,?,?)`,
    [orderId, shopId, orderNumber, JSON.stringify(orderItems), total, `LINE: ${lineUserId}`, now, now]
  );

  return { orderId, orderNumber, orderItems, total };
}

// ─── Process a single LINE event ──────────────────────────────────────────────

async function processEvent(event, shop, products, knowledgeBase) {
  if (event.type !== 'message' || event.message?.type !== 'text') return;

  const userId = event.source?.userId;
  const replyToken = event.replyToken;
  const userText = event.message.text?.trim();

  if (!userId || !replyToken || !userText) return;

  // DEBUG: reply diagnostic info
  if (userText === 'DEBUG_PAIR') {
    const db = getDb();
    const row = await db.get(`SELECT pairing_code, pairing_code_expires_at FROM shops WHERE id = ?`, [shop.id]).catch(() => null);
    await replyToLine(replyToken, `[v2] shopId=${shop.id}\ncode=${row?.pairing_code ?? 'null'}\nexpires=${row?.pairing_code_expires_at ?? 'null'}\nnow=${new Date().toISOString()}`, shop.line_access_token);
    return;
  }

  // Check if message matches active pairing code (no expiry check — accept any stored code)
  {
    const db = getDb();
    let shopRecord = null;
    try {
      shopRecord = await db.get(`SELECT pairing_code FROM shops WHERE id = ?`, [shop.id]);
    } catch (e) {
      console.error('[pairing] db error:', e.message);
    }
    if (shopRecord?.pairing_code && userText.toUpperCase() === shopRecord.pairing_code) {
      await db.run(
        `UPDATE shops SET owner_line_user_id = ?, pairing_code = NULL, pairing_code_expires_at = NULL WHERE id = ?`,
        [userId, shop.id]
      );
      await replyToLine(replyToken, '✅ เชื่อมต่อสำเร็จ! คุณจะได้รับแจ้งเตือน Handoff ทาง LINE นี้ค่ะ', shop.line_access_token);
      return;
    }
  }

  // ── Order cart flow ──────────────────────────────────────────────────────────
  const db = getDb();
  const cart = await db.get(
    `SELECT * FROM line_carts WHERE shop_id = ? AND line_user_id = ? AND state = 'awaiting_confirm' ORDER BY created_at DESC LIMIT 1`,
    [shop.id, userId]
  ).catch(() => null);

  if (cart) {
    if (CONFIRM_PATTERNS.test(userText)) {
      // Customer confirmed → create order
      const items = JSON.parse(cart.items || '[]');
      try {
        const { orderNumber, orderItems, total } = await createInternalOrder(db, shop.id, userId, items);
        await db.run(`UPDATE line_carts SET state='confirmed', updated_at=? WHERE id=?`, [new Date().toISOString(), cart.id]);
        const receipt = `✅ สั่งสินค้าสำเร็จแล้วค่ะ!\n\n` +
          `🧾 เลขที่: ${orderNumber}\n` +
          orderItems.map(i => `• ${i.productName} x${i.quantity} = ฿${(i.price * i.quantity).toLocaleString()}`).join('\n') +
          `\n\n💰 รวมทั้งหมด: ฿${total.toLocaleString()}\nทางร้านจะเตรียมของให้เร็วๆ นี้นะคะ 🐱`;
        await replyToLine(replyToken, receipt, shop.line_access_token);
        await saveConversationTurn(shop.id, userId, userText, receipt, false).catch(() => {});
        return;
      } catch (err) {
        console.error('[order-create]', err.message);
        await replyToLine(replyToken, 'ขออภัยค่ะ เกิดข้อผิดพลาดในการสั่งสินค้า กรุณาลองใหม่นะคะ', shop.line_access_token);
        return;
      }
    }

    if (CANCEL_PATTERNS.test(userText)) {
      await db.run(`UPDATE line_carts SET state='cancelled', updated_at=? WHERE id=?`, [new Date().toISOString(), cart.id]);
      await replyToLine(replyToken, 'ยกเลิกคำสั่งซื้อเรียบร้อยแล้วค่ะ 😊 มีอะไรให้ช่วยอีกไหมคะ?', shop.line_access_token);
      await saveConversationTurn(shop.id, userId, userText, 'ยกเลิกคำสั่งซื้อ', false).catch(() => {});
      return;
    }
    // If neither confirm/cancel → let AI handle but keep cart alive
  }

  // ── Detect new order intent (only if no pending cart) ─────────────────────
  if (!cart && products.length > 0) {
    const orderItems = await detectOrder(userText, products);
    if (orderItems) {
      const outOfStock = orderItems.filter(i => i.outOfStock);
      if (outOfStock.length > 0) {
        const names = outOfStock.map(i => i.name).join(', ');
        await replyToLine(replyToken, `ขออภัยค่ะ สินค้า ${names} หมดแล้วนะคะ 😿 มีอะไรอื่นให้ช่วยไหมคะ?`, shop.line_access_token);
        await saveConversationTurn(shop.id, userId, userText, `สินค้า ${names} หมด`, false).catch(() => {});
        return;
      }

      const validItems = orderItems.filter(i => !i.outOfStock);
      const total = validItems.reduce((s, i) => s + i.price * i.qty, 0);
      const cartId = 'cart_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      await db.run(
        `INSERT INTO line_carts (id,shop_id,line_user_id,items,total_amount,state,created_at,updated_at) VALUES (?,?,?,?,?,'awaiting_confirm',?,?)`,
        [cartId, shop.id, userId, JSON.stringify(validItems), total, new Date().toISOString(), new Date().toISOString()]
      ).catch(e => console.error('[cart save]', e.message));

      const confirm = `🛒 สรุปรายการสั่งซื้อค่ะ\n\n` +
        validItems.map(i => `• ${i.name} x${i.qty} = ฿${(i.price * i.qty).toLocaleString()}`).join('\n') +
        `\n\n💰 รวม: ฿${total.toLocaleString()}\n\nยืนยันสั่งซื้อไหมคะ? (พิมพ์ "ยืนยัน" หรือ "ยกเลิก")`;
      await replyToLine(replyToken, confirm, shop.line_access_token);
      await saveConversationTurn(shop.id, userId, userText, confirm, false).catch(() => {});
      return;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

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
      `SELECT s.owner_line_user_id, s.line_access_token, s.name as shop_name, u.email as owner_email
       FROM shops s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      [shop.id]
    ).catch(() => null);
    if (shopForNotify?.owner_line_user_id && shopForNotify?.line_access_token) {
      pushToLine(
        shopForNotify.owner_line_user_id,
        `🔔 ลูกค้าขอคุยกับพนักงาน!\nลูกค้า: ${customerName || userId}\nข้อความ: "${userText}"\n\n👉 my.meowchat.store`,
        shopForNotify.line_access_token
      );
    }
    // Email backup — always send if merchant has email
    if (shopForNotify?.owner_email) {
      sendEscalationEmail({
        to: shopForNotify.owner_email,
        shopName: shopForNotify.shop_name,
        customerName: customerName || userId,
        message: userText,
      }).catch(e => console.error('[email] escalation:', e.message));
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
