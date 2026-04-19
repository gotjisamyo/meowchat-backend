require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const line = require('@line/bot-sdk');
const { initDatabase, getDb } = require('./db');
const { handleLineEvent } = require('./lineHandler');
const { setupRoutes } = require('./routes');
const { setupBillingRoutes } = require('./routes/billing');
const { authMiddleware } = require('./auth');
const { requireOwnedShop } = require('./middleware/shopAccess');

const app = express();

// Trust Railway/proxy reverse proxy so rate-limiter sees real client IPs
app.set("trust proxy", 1);

// Security headers
app.use(helmet());

// Middleware
const allowedOrigins = [
  'https://app.meowchat.store',
  'https://meowchat.store',
  'https://my.meowchat.store',
  'https://meowchat-admin-dashboard.vercel.app',
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
].filter(Boolean);

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? (origin, cb) => {
        // allow requests with no origin (mobile apps, curl) or exact-matching origins
        if (!origin || allowedOrigins.includes(origin)) {
          cb(null, true);
        } else {
          cb(new Error(`CORS blocked: ${origin}`));
        }
      }
    : true,
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
// Handle OPTIONS preflight for all routes
app.options('*', cors());
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith('/api/billing/webhook') ||
        req.originalUrl.startsWith('/api/line/webhook')) {
      req.rawBody = Buffer.from(buf);
    }
  }
}));
app.use(express.urlencoded({ extended: true }));

// Return JSON for malformed body (prevents HTML "Bad Request" responses)
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Bad Request', message: 'รูปแบบ JSON ไม่ถูกต้อง' });
  }
  next(err);
});

// ─── Request logging middleware — feeds /api/admin/api-usage + /endpoint-stats ──
const SKIP_LOG_PREFIXES = ['/health', '/api/line/webhook', '/api/internal/'];

// Normalize path: replace UUIDs and numeric IDs with :id so grouping works
function normalizePath(p) {
  return p
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

let _pruneScheduled = false;
function scheduleLogPrune(db) {
  if (_pruneScheduled) return;
  _pruneScheduled = true;
  setTimeout(async () => {
    _pruneScheduled = false;
    try {
      await db.run(`DELETE FROM request_logs WHERE created_at < NOW() - INTERVAL '30 days'`);
    } catch { /* ignore */ }
  }, 5000);
}

app.use((req, res, next) => {
  const skip = SKIP_LOG_PREFIXES.some(p => req.path.startsWith(p));
  if (skip) return next();
  const startMs = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startMs;
    const path = normalizePath(req.path);
    try {
      const { getDb } = require('./db');
      const db = getDb();
      db.run(
        `INSERT INTO request_logs (path, method, status_code, duration_ms) VALUES (?, ?, ?, ?)`,
        [path, req.method, res.statusCode, duration]
      ).catch(() => {});
      scheduleLogPrune(db);
    } catch { /* db not ready yet */ }
  });
  next();
});

// LINE Bot SDK configuration
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};

// LINE webhook GET — for LINE platform probe/verify check
app.get('/api/line/webhook', (req, res) => res.json({ ok: true }));

// LINE webhook — always registered, returns 503 if not configured
app.post('/api/line/webhook', (req, res, next) => {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
    return res.status(503).json({
      error: 'LINE not configured',
      message: 'LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET not set'
    });
  }
  line.middleware(lineConfig)(req, res, (err) => {
    if (err) {
      console.error('LINE signature validation error:', err.message);
      // Still return 200 so LINE platform doesn't report error
      // but skip processing if signature is invalid
      return res.json({ ok: true });
    }
    const events = req.body.events || [];
    Promise.all(
      events.map(event => handleLineEvent(event, lineConfig))
    ).then(() => res.json({ ok: true }))
     .catch(err => {
       console.error('LINE event error:', err);
       res.status(500).json({ error: 'Internal error' });
     });
  });
});
if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
  console.log('LINE credentials not configured - webhook returns 503 until set');
}

// Health check — always responds so Railway healthcheck passes
let dbReady = false;
app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: dbReady ? 'connected' : 'initializing', timestamp: new Date().toISOString(), v: 'pairing-v2' });
});

// API routes
setupRoutes(app);
setupBillingRoutes(app);

// Auth routes
const authRoutes = require('./routes/auth');
const shopRoutes = require('./routes/shops');
const productRoutes = require('./routes/products');
app.use('/api/auth', authRoutes);
app.use('/api/users', authRoutes);
app.use('/api/shops', shopRoutes);
app.use('/api/products', productRoutes);
app.use('/api/marketing', require('./routes/marketing'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/crm', require('./routes/crm'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/team', require('./routes/team'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/payment', require('./routes/payment'));
const { router: handoffsRouter, broadcastHandoffEvent } = require('./routes/handoffs');
const { pushToLine } = require('./utils/line-push');
app.use('/api/handoffs', handoffsRouter);
app.use('/api/admin', require('./routes/admin'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/credits', authMiddleware, require('./routes/credits'));

// Merchant dashboard routes
const botsRouter = require('./routes/bots');
const usageRouter = require('./routes/usage');
app.use('/api/bots', authMiddleware, botsRouter);
app.use('/api/usage', authMiddleware, usageRouter);
const { publicRouter: uploadPublic, authRouter: uploadAuth } = require('./routes/upload');
app.use('/api/upload/serve', uploadPublic);           // public — no auth
app.use('/api/upload', authMiddleware, uploadAuth);   // POST /image — needs auth

// Per-shop LINE webhooks: POST /api/line/webhook/:shopId
// rawBody already captured above for /api/line/webhook/* prefix
app.use('/api/line/webhook', require('./routes/line'));

// LINE credential test — alias /api/line/test → /api/bots/line-test (with auth)
app.post('/api/line/test', authMiddleware, (req, res, next) => {
  req.url = '/line-test';
  botsRouter(req, res, next);
});

// ─── Internal API — called by meowchat-engine to log conversations ─────────────
const { trackEvent, EVENTS } = require('./events');
app.post('/api/internal/log', async (req, res) => {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { botId, lineUserId, userText, botReply, escalated } = req.body;
  if (!botId || !lineUserId) {
    return res.status(400).json({ error: 'botId and lineUserId required' });
  }
  try {
    const { getDb } = require('./db');
    const db = await getDb();

    // Upsert conversation row (one row per LINE user per shop)
    let conv = await db.get(
      'SELECT id, escalated FROM conversations WHERE shop_id = ? AND line_user_id = ?',
      [botId, lineUserId]
    );
    const wasEscalated = conv?.escalated;
    if (!conv) {
      const result = await db.run(
        `INSERT INTO conversations (shop_id, line_user_id, customer_name, status, escalated)
         VALUES (?, ?, ?, 'active', ?) RETURNING id`,
        [botId, lineUserId, lineUserId, escalated ? 1 : 0]
      );
      conv = { id: result.lastInsertRowid, escalated: escalated ? 1 : 0 };
      // First conversation for this shop — track funnel event
      trackEvent(botId, EVENTS.FIRST_REPLY).catch(() => {});
    } else {
      await db.run(
        'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP, escalated = ? WHERE id = ?',
        [escalated ? 1 : conv.escalated, conv.id]
      );
    }

    // Save both turns as messages
    if (userText) {
      await db.run(
        'INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, ?, ?)',
        [conv.id, 'user', userText]
      );
    }
    if (botReply) {
      await db.run(
        'INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, ?, ?)',
        [conv.id, 'assistant', botReply]
      );
    }

    // Auto-create customer record if first time seeing this LINE user
    const existingCustomer = await db.get(
      'SELECT id FROM customers WHERE shop_id = ? AND line_user_id = ? LIMIT 1',
      [botId, lineUserId]
    );
    if (!existingCustomer) {
      const custId = 'cust_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      await db.run(
        `INSERT INTO customers (id, shop_id, line_user_id, name, customer_group, status)
         VALUES (?, ?, ?, ?, 'regular', 'active')`,
        [custId, botId, lineUserId, `LINE ${lineUserId.slice(-6)}`]
      ).catch(() => {}); // ignore duplicate in race

      // Fire-and-forget: fetch LINE display name and update
      (async () => {
        try {
          const shop = await db.get('SELECT line_access_token FROM shops WHERE id = ?', [botId]);
          const lineToken = shop?.line_access_token || process.env.LINE_CHANNEL_ACCESS_TOKEN;
          if (!lineToken) return;
          const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
            headers: { Authorization: `Bearer ${lineToken}` },
          });
          if (!profileRes.ok) return;
          const profile = await profileRes.json();
          if (profile.displayName) {
            await db.run(
              'UPDATE customers SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              [profile.displayName, custId]
            );
            await db.run(
              'UPDATE conversations SET customer_name = ? WHERE shop_id = ? AND line_user_id = ?',
              [profile.displayName, botId, lineUserId]
            );
            // Also update any pending/active handoffs for this user
            await db.run(
              `UPDATE handoffs SET customer_name = ?, updated_at = CURRENT_TIMESTAMP
               WHERE shop_id = ? AND line_user_id = ? AND status IN ('pending', 'active')`,
              [profile.displayName, botId, lineUserId]
            );
          }
        } catch { /* non-fatal */ }
      })();
    }

    // Create handoff record + notify when escalated and no active handoff exists
    if (escalated) {
      const existingHandoff = await db.get(
        `SELECT id FROM handoffs WHERE shop_id = ? AND line_user_id = ? AND status IN ('pending', 'active') LIMIT 1`,
        [botId, lineUserId]
      ).catch(() => null);

      if (!existingHandoff) {
        // Look up customer name for the handoff card
        const customer = await db.get(
          'SELECT name FROM customers WHERE shop_id = ? AND line_user_id = ? LIMIT 1',
          [botId, lineUserId]
        ).catch(() => null);
        const customerName = customer?.name || lineUserId;

        const handoffId = 'hdo_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
        await db.run(
          `INSERT INTO handoffs (id, shop_id, line_user_id, customer_name, message, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO NOTHING`,
          [handoffId, botId, lineUserId, customerName, userText || '']
        ).catch(e => console.warn('[handoff] insert failed:', e.message));

        // Push LINE notification to merchant if they have paired their LINE
        const shopForNotify = await db.get(
          'SELECT owner_line_user_id, line_access_token FROM shops WHERE id = ?',
          [botId]
        );
        if (shopForNotify?.owner_line_user_id && shopForNotify?.line_access_token) {
          pushToLine(
            shopForNotify.owner_line_user_id,
            `🔔 ลูกค้าขอคุยกับพนักงาน!\nลูกค้า: ${customerName || 'ลูกค้า'}\nข้อความ: "${userText || ''}"\n\n👉 my.meowchat.store`,
            shopForNotify.line_access_token
          );
        }

        broadcastHandoffEvent('handoff_new', {
          id: handoffId,
          shop_id: botId,
          line_user_id: lineUserId,
          customer_name: customerName,
          message: userText || '',
          status: 'pending',
          created_at: new Date().toISOString(),
        });
      }
    }

    res.json({ ok: true, conversationId: conv.id });
  } catch (err) {
    console.error('[internal/log] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Internal API — slip order notification from engine ───────────────────────
app.post('/api/internal/slip-order', async (req, res) => {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { botId, lineUserId, amount, date, refNumber, bankName, mode } = req.body;
  if (!botId || !lineUserId) {
    return res.status(400).json({ error: 'botId and lineUserId required' });
  }
  try {
    const { getDb } = require('./db');
    const db = await getDb();
    const status = mode === 'auto' ? 'approved' : 'pending';
    const shop = await db.get('SELECT name FROM shops WHERE id = ?', [botId]);
    await db.run(
      `INSERT INTO payment_notifications
         (shop_id, payer_name, amount, transfer_date, bank_name, account_name, account_number, ref_number, status)
       VALUES (?, ?, ?, ?, ?, 'MeowChat', '-', ?, ?)`,
      [botId, lineUserId, amount ?? 0, date ?? new Date().toISOString().slice(0,10), bankName ?? '-', refNumber ?? null, status]
    );
    res.json({ ok: true, status });

    // Push LINE notification to admin (fire-and-forget)
    const adminUserId = process.env.ADMIN_LINE_USER_ID;
    const channelToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (adminUserId && channelToken) {
      const shopName = shop?.name || botId;
      const amountText = amount ? `฿${Number(amount).toLocaleString()}` : 'ไม่ทราบจำนวน';
      const statusText = mode === 'auto' ? '✅ อนุมัติอัตโนมัติ' : '⏳ รอตรวจสอบ';
      fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channelToken}` },
        body: JSON.stringify({
          to: adminUserId,
          messages: [{ type: 'text', text: `💰 สลิปใหม่!\nร้าน: ${shopName}\nจำนวน: ${amountText}\nสถานะ: ${statusText}\n\n👉 app.meowchat.store` }],
        }),
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[internal/slip-order] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Internal: create order from LINE bot ────────────────────────────────────

app.post('/api/internal/bot-order', async (req, res) => {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { botId, lineUserId, items, note } = req.body;
  if (!botId || !lineUserId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'botId, lineUserId, and items required' });
  }

  try {
    const { getDb } = require('./db');
    const db = await getDb();

    // Resolve product IDs by fuzzy name match within this shop
    const resolvedItems = [];
    let computedTotal = 0;

    for (const { name, qty = 1, price: hintPrice } of items) {
      const quantity = Math.max(1, parseInt(qty) || 1);
      // Case-insensitive partial match
      const product = await db.get(
        `SELECT * FROM products WHERE shop_id = ? AND LOWER(name) LIKE LOWER(?) AND status = 'active' LIMIT 1`,
        [botId, `%${name}%`]
      );
      // Fallback: if no product catalog match, create custom item so order still goes through
      // Merchant can see it in dashboard and handle manually
      const price = product ? Number(product.price) || 0 : Number(hintPrice) || 0;
      computedTotal += price * quantity;
      resolvedItems.push({
        productId: product?.id ?? null,
        productName: product?.name ?? name,
        quantity,
        price,
        custom: !product, // flag so merchant knows this wasn't in catalog
      });
    }

    // Find or create customer record by lineUserId
    let customer = await db.get(
      `SELECT * FROM customers WHERE shop_id = ? AND line_user_id = ? LIMIT 1`,
      [botId, lineUserId]
    );
    if (!customer) {
      // Auto-create customer if first interaction is an order
      const custId = 'cust_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      await db.run(
        `INSERT INTO customers (id, shop_id, line_user_id, name, customer_group, status)
         VALUES (?, ?, ?, ?, 'regular', 'active')`,
        [custId, botId, lineUserId, `LINE ${lineUserId.slice(-6)}`]
      ).catch(() => {});
      customer = await db.get('SELECT * FROM customers WHERE id = ?', [custId]);
      // Fire-and-forget: fetch LINE display name
      (async () => {
        try {
          const shop = await db.get('SELECT line_access_token FROM shops WHERE id = ?', [botId]);
          if (!shop?.line_access_token) return;
          const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
            headers: { Authorization: `Bearer ${shop.line_access_token}` },
          });
          if (!profileRes.ok) return;
          const profile = await profileRes.json();
          if (profile.displayName) {
            await db.run(
              'UPDATE customers SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              [profile.displayName, custId]
            );
          }
        } catch { /* non-fatal */ }
      })();
    }

    const orderNumber = 'BOT-' + Date.now();
    const now = new Date().toISOString();

    // Deduct stock for สินค้า type items
    for (const ri of resolvedItems) {
      const inv = await db.get(
        'SELECT * FROM inventory WHERE shop_id = ? AND product_id = ?',
        [botId, ri.productId]
      );
      if (inv) {
        await db.run(
          'UPDATE inventory SET quantity = GREATEST(0, quantity - ?), updated_at = ? WHERE id = ?',
          [ri.quantity, now, inv.id]
        );
      }
    }

    // Legacy NOT NULL columns: "lineId", product, quantity, price
    const legacyProduct = resolvedItems.map(i => `${i.productName} x${i.quantity}`).join(', ');
    const legacyQty = resolvedItems[0]?.quantity ?? 1;
    const legacyPrice = resolvedItems[0]?.price ?? 0;

    await db.run(
      `INSERT INTO orders ("lineId", product, quantity, price, shop_id, customer_id, order_number, status, items, total_amount, payment_method, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'bot', ?, ?, ?)`,
      [
        lineUserId, legacyProduct, legacyQty, legacyPrice,
        botId, customer?.id ?? null, orderNumber,
        JSON.stringify(resolvedItems), computedTotal,
        note ?? '', now, now
      ]
    );

    // Update customer stats
    if (customer?.id) {
      await db.run(
        `UPDATE customers SET total_orders = total_orders + 1, total_spent = total_spent + ?,
         last_order_at = ?, first_order_at = COALESCE(first_order_at, ?), updated_at = ?
         WHERE id = ?`,
        [computedTotal, now, now, now, customer.id]
      );
    }

    (async () => {
      try {
        const shop = await db.get('SELECT name FROM shops WHERE id = ?', [botId]);
        const itemLines = resolvedItems.map(i => `• ${i.productName} x${i.quantity} ฿${(i.price * i.quantity).toLocaleString()}`).join('\n');
        await pushAdminNotify(`🛒 ออเดอร์ใหม่ ${orderNumber}\nร้าน: ${shop?.name || botId}\nยอดรวม: ฿${computedTotal.toLocaleString()}\n${itemLines}${note ? `\nหมายเหตุ: ${note}` : ''}`);
      } catch (e) { console.warn('[notify] bot-order notify failed:', e.message); }
    })();

    res.json({ ok: true, orderNumber, items: resolvedItems, total: computedTotal });
  } catch (err) {
    console.error('[internal/bot-order] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Internal: Product Image Lookup ──────────────────────────────────────────
app.get('/api/internal/product-image', async (req, res) => {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) return res.status(401).json({ error: 'unauthorized' });

  const { botId, name } = req.query;
  if (!botId || !name) return res.status(400).json({ error: 'botId and name required' });

  try {
    const { getDb } = require('./db');
    const db = getDb();
    const product = await db.get(
      `SELECT name, price, "imageUrl", description FROM products
       WHERE shop_id = ? AND LOWER(name) LIKE LOWER(?) AND status = 'active' LIMIT 1`,
      [botId, `%${name}%`]
    );
    if (!product) return res.status(404).json({ error: 'not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Internal: Bot Booking Creation ──────────────────────────────────────────
app.post('/api/internal/bot-booking', async (req, res) => {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { botId, lineUserId, service, datetime, note } = req.body;
  if (!botId || !lineUserId || !service) {
    return res.status(400).json({ error: 'botId, lineUserId, and service required' });
  }

  try {
    const { getDb } = require('./db');
    const db = await getDb();

    let customer = await db.get(
      `SELECT * FROM customers WHERE shop_id = ? AND line_user_id = ? LIMIT 1`,
      [botId, lineUserId]
    );
    if (!customer) {
      const custId = 'cust_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      await db.run(
        `INSERT INTO customers (id, shop_id, line_user_id, name, customer_group, status)
         VALUES (?, ?, ?, ?, 'regular', 'active')`,
        [custId, botId, lineUserId, `LINE ${lineUserId.slice(-6)}`]
      ).catch(() => {});
      customer = await db.get('SELECT * FROM customers WHERE id = ?', [custId]);
    }

    const bookingId = 'bk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO bookings (id, shop_id, customer_id, line_user_id, customer_name, service, booking_datetime, status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [bookingId, botId, customer?.id ?? null, lineUserId, customer?.name ?? 'ลูกค้า', service, datetime ?? null, note ?? '', now, now]
    );

    (async () => {
      try {
        const shop = await db.get('SELECT name FROM shops WHERE id = ?', [botId]);
        const dateStr = datetime ? `\nวันเวลา: ${datetime}` : '';
        await pushAdminNotify(`📅 นัดหมายใหม่!\nร้าน: ${shop?.name || botId}\nบริการ: ${service}${dateStr}${note ? `\nหมายเหตุ: ${note}` : ''}`);
      } catch (e) { console.warn('[notify] bot-booking notify failed:', e.message); }
    })();

    res.json({ ok: true, bookingId, service, datetime });
  } catch (err) {
    console.error('[internal/bot-booking] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Analytics: what customers are asking about ──────────────────────────────
app.get('/api/bots/:botId/analytics/topics', authMiddleware, async (req, res) => {
  try {
    const { getDb } = require('./db');
    const db = await getDb();
    const { botId } = req.params;
    const parsedDays = parseInt(req.query.days || '30');
    const days = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 90) : 30;

    // Verify ownership
    const shop = await db.get('SELECT id FROM shops WHERE id = ? AND user_id = ?', [botId, req.userId]);
    if (!shop) return res.status(403).json({ error: 'Forbidden' });

    // Get all user messages for this bot in the time range
    const messages = await db.all(
      `SELECT cm.content FROM conversation_messages cm
       JOIN conversations cv ON cv.id = cm.conversation_id
       WHERE cv.shop_id = ? AND cm.role = 'user'
         AND cm.created_at >= NOW() - INTERVAL '${days} days'
       ORDER BY cm.created_at DESC LIMIT 1000`,
      [botId]
    );

    // Simple keyword frequency analysis
    const stopwords = new Set(['ครับ','ค่ะ','คะ','นะ','ๆ','และ','แล้ว','ก็','ได้','ไม่','มี','ที่','จะ','ว่า','ใน','ของ','กับ','หรือ','แต่','เป็น','ให้','มา','ไป','อยู่','อยาก','ต้อง','ขอ']);
    const freq = {};
    for (const { content } of messages) {
      const words = content.replace(/[^\u0E00-\u0E7Fa-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !stopwords.has(w));
      for (const w of words) {
        freq[w] = (freq[w] || 0) + 1;
      }
    }

    // Top keywords
    const topKeywords = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word, count]) => ({ word, count }));

    // Conversation stats
    const stats = await db.get(
      `SELECT
         COUNT(DISTINCT cv.id) as total_conversations,
         COUNT(cm.id) as total_messages,
         COUNT(DISTINCT cv.line_user_id) as unique_users,
         COUNT(CASE WHEN cv.escalated = 1 THEN 1 END) as escalations
       FROM conversations cv
       LEFT JOIN conversation_messages cm ON cm.conversation_id = cv.id
       WHERE cv.shop_id = ? AND cv.created_at >= NOW() - INTERVAL '${days} days'`,
      [botId]
    );

    // Recent sample messages (last 10 unique users' first message)
    const recentSamples = await db.all(
      `SELECT DISTINCT ON (cv.line_user_id) cm.content, cv.created_at
       FROM conversation_messages cm
       JOIN conversations cv ON cv.id = cm.conversation_id
       WHERE cv.shop_id = ? AND cm.role = 'user'
         AND cm.created_at >= NOW() - INTERVAL '${days} days'
       ORDER BY cv.line_user_id, cm.created_at ASC
       LIMIT 10`,
      [botId]
    );

    res.json({
      days,
      stats: {
        totalConversations: Number(stats?.total_conversations || 0),
        totalMessages: Number(stats?.total_messages || 0),
        uniqueUsers: Number(stats?.unique_users || 0),
        escalations: Number(stats?.escalations || 0),
      },
      topKeywords,
      recentSamples: recentSamples.map(r => ({ message: r.content, at: r.created_at })),
    });
  } catch (err) {
    console.error('[analytics/topics] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Analytics Overview — daily breakdown + stats + keywords
app.get('/api/bots/:botId/analytics/overview', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const { botId } = req.params;
    const parsedDays = parseInt(req.query.days || '30');
    const days = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 90) : 30;

    // Verify ownership
    const shop = await db.get('SELECT id FROM shops WHERE id = ? AND user_id = ?', [botId, req.userId]);
    if (!shop) return res.status(403).json({ error: 'Forbidden' });

    const daily = await db.all(
      `SELECT
         DATE(cv.created_at AT TIME ZONE 'Asia/Bangkok') as day,
         COUNT(DISTINCT cv.id) as conversations,
         COUNT(DISTINCT cv.line_user_id) as unique_users,
         COUNT(CASE WHEN cv.escalated = 1 THEN 1 END) as escalations
       FROM conversations cv
       WHERE cv.shop_id = ?
         AND cv.created_at >= NOW() - INTERVAL '${days} days'
       GROUP BY DATE(cv.created_at AT TIME ZONE 'Asia/Bangkok')
       ORDER BY day ASC`,
      [botId]
    );

    const stats = await db.get(
      `SELECT
         COUNT(DISTINCT cv.id) as total_conversations,
         COUNT(cm.id) as total_messages,
         COUNT(DISTINCT cv.line_user_id) as unique_users,
         COUNT(CASE WHEN cv.escalated = 1 THEN 1 END) as escalations
       FROM conversations cv
       LEFT JOIN conversation_messages cm ON cm.conversation_id = cv.id
       WHERE cv.shop_id = ? AND cv.created_at >= NOW() - INTERVAL '${days} days'`,
      [botId]
    );

    const messages = await db.all(
      `SELECT cm.content FROM conversation_messages cm
       JOIN conversations cv ON cv.id = cm.conversation_id
       WHERE cv.shop_id = ? AND cm.role = 'user'
         AND cm.created_at >= NOW() - INTERVAL '${days} days'
       ORDER BY cm.created_at DESC LIMIT 1000`,
      [botId]
    );

    const stopwords = new Set(['ครับ','ค่ะ','คะ','นะ','ๆ','และ','แล้ว','ก็','ได้','ไม่','มี','ที่','จะ','ว่า','ใน','ของ','กับ','หรือ','แต่','เป็น','ให้','มา','ไป','อยู่','อยาก','ต้อง','ขอ','เลย','ค่า','ราคา','นี้','นั้น','อัน']);
    const freq = {};
    for (const { content } of messages) {
      const words = content.replace(/[^\u0E00-\u0E7Fa-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !stopwords.has(w));
      for (const w of words) freq[w] = (freq[w] || 0) + 1;
    }
    const topKeywords = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word, count]) => ({ word, count }));

    const total = Number(stats?.total_conversations || 0);
    const esc = Number(stats?.escalations || 0);

    res.json({
      days,
      stats: {
        totalConversations: total,
        totalMessages: Number(stats?.total_messages || 0),
        uniqueUsers: Number(stats?.unique_users || 0),
        escalations: esc,
        aiResponseRate: total > 0 ? Math.round(((total - esc) / total) * 100) : 100,
        timeSavedHours: Math.round((total * 3) / 60),
      },
      daily: daily.map(d => ({
        day: d.day,
        conversations: Number(d.conversations),
        uniqueUsers: Number(d.unique_users),
        escalations: Number(d.escalations),
      })),
      topKeywords,
    });
  } catch (err) {
    console.error('[analytics/overview] error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function pushAdminNotify(text) {
  const adminUserId = process.env.ADMIN_LINE_USER_ID;
  const channelToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!adminUserId || !channelToken) return;
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channelToken}` },
    body: JSON.stringify({ to: adminUserId, messages: [{ type: 'text', text }] }),
  });
  console.log('[notify] admin push sent');
}

async function sendTrialReminders() {
  try {
    const db = getDb();
    if (!db) return;
    const shops = await db.all(`
      SELECT s.id, s.name
      FROM shops s
      WHERE s.trial_ends_at IS NOT NULL
        AND s.trial_reminder_sent = FALSE
        AND s.trial_ends_at BETWEEN NOW() + INTERVAL '3 days' AND NOW() + INTERVAL '5 days'
    `);
    for (const shop of shops) {
      await db.run(`UPDATE shops SET trial_reminder_sent = TRUE WHERE id = ?`, [shop.id]);
      console.log(`[trial-reminder] marked shop=${shop.id} (${shop.name})`);
    }
  } catch (err) {
    console.error('[trial-reminder] scheduler error:', err.message);
  }
}

async function sendDay3Notifications() {
  // TODO: replace with merchant LINE push once merchant LINE user ID is stored
}

async function sendWeeklySummary() {
  // TODO: replace with merchant LINE push once merchant LINE user ID is stored
}

// Subscription State Machine — runs daily
// trial → grace (3 days) → expired+locked
async function runSubscriptionStateMachine() {
  try {
    const db = getDb();
    if (!db) return;

    // 1. Trial expired → enter grace period (3 days)
    await db.run(`
      UPDATE shops
      SET subscription_status = 'grace',
          grace_period_ends_at = NOW() + INTERVAL '3 days'
      WHERE subscription_status = 'trial'
        AND trial_ends_at < NOW()
        AND bot_locked = FALSE
    `);

    // 2. Grace period over → lock bot
    const expired = await db.all(`
      SELECT id, name
      FROM shops
      WHERE subscription_status = 'grace'
        AND grace_period_ends_at < NOW()
        AND bot_locked = FALSE
    `);
    for (const shop of expired) {
      await db.run(`UPDATE shops SET bot_locked = TRUE, subscription_status = 'expired' WHERE id = ?`, [shop.id]);
      console.log(`[state-machine] locked bot for shop=${shop.id} (${shop.name})`);
    }
  } catch (err) {
    console.error('[state-machine] error:', err.message);
  }
}

// Scheduled message delivery — runs every 5 minutes
async function sendScheduledMessages() {
  try {
    const db = getDb();
    if (!db) return;
    const pending = await db.all(`
      SELECT ms.*, s.line_access_token
      FROM marketing_scheduled ms
      JOIN shops s ON s.id = ms.shop_id
      WHERE ms.status = 'pending'
        AND ms.send_at <= NOW()
        AND s.line_access_token IS NOT NULL
      LIMIT 50
    `);
    for (const msg of pending) {
      // Get customer's LINE user ID
      const customer = await db.get('SELECT line_user_id FROM customers WHERE id = ?', [msg.customer_id]);
      if (!customer?.line_user_id) {
        await db.run(`UPDATE marketing_scheduled SET status = 'skipped', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [msg.id]);
        continue;
      }
      try {
        const resp = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${msg.line_access_token}` },
          body: JSON.stringify({ to: customer.line_user_id, messages: [{ type: 'text', text: msg.message }] }),
        });
        const status = resp.ok ? 'sent' : 'failed';
        await db.run(`UPDATE marketing_scheduled SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, msg.id]);
        if (resp.ok) console.log(`[scheduled-msg] sent id=${msg.id} shop=${msg.shop_id}`);
        else console.warn(`[scheduled-msg] failed id=${msg.id} status=${resp.status}`);
      } catch (e) {
        await db.run(`UPDATE marketing_scheduled SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [msg.id]);
      }
    }
  } catch (err) {
    console.error('[scheduled-msg] error:', err.message);
  }
}

// Run all schedulers: startup delay then every 24h (message delivery every 5min)
setTimeout(() => {
  sendTrialReminders();
  sendDay3Notifications();
  sendWeeklySummary();
  runSubscriptionStateMachine();
  sendScheduledMessages();
  setInterval(sendScheduledMessages, 5 * 60 * 1000); // every 5 minutes
  setInterval(() => {
    sendTrialReminders();
    sendDay3Notifications();
    sendWeeklySummary();
    runSubscriptionStateMachine();
  }, 24 * 60 * 60 * 1000);
}, 30 * 1000);

// Chat API - Direct
const { processUserMessage } = require('./agent');
app.post('/api/chat', authMiddleware, async (req, res) => {
  try {
    const { message, shopId, businessType, aiPersonality, aiResponseStyle, aiCustomKnowledge } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (String(message).length > 1000) {
      return res.status(400).json({ error: 'message must be ≤ 1000 characters' });
    }
    if (!shopId) {
      return res.status(400).json({ error: 'shopId is required' });
    }
    if (!await requireOwnedShop(req, res, shopId)) {
      return;
    }

    const result = await processUserMessage(String(req.userId), message, req.shopId, {
      businessType,
      aiPersonality,
      aiResponseStyle,
      aiCustomKnowledge
    });
    res.json(result);
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server — listen first, then init DB so healthcheck passes immediately
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 MeowChat Backend running on port ${PORT}`);
});

initDatabase()
  .then(async () => {
    dbReady = true;
    // Promote ADMIN_EMAIL to admin role on startup (idempotent)
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      try {
        const db = getDb();
        const result = await db.run(
          `UPDATE users SET role = 'admin' WHERE email = ? AND role != 'admin'`,
          [adminEmail]
        );
        if (result.changes > 0) console.log(`[startup] promoted ${adminEmail} → admin`);
      } catch (e) {
        console.error('[startup] admin seed error:', e.message);
      }
    }
  })
  .catch(err => {
    console.error('❌ DB init failed:', err.message || err.code || String(err));
    // Don't exit — let the process stay up so Railway doesn't loop-restart
  });

module.exports = { app, lineConfig };
