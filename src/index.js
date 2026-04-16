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
  res.json({ status: 'ok', db: dbReady ? 'connected' : 'initializing', timestamp: new Date().toISOString() });
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
app.use('/api/admin', require('./routes/admin'));
app.use('/api/referral', require('./routes/referral'));
app.use('/api/credits', authMiddleware, require('./routes/credits'));

// Merchant dashboard routes
const botsRouter = require('./routes/bots');
const usageRouter = require('./routes/usage');
app.use('/api/bots', authMiddleware, botsRouter);
app.use('/api/usage', authMiddleware, usageRouter);

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
            // Also update conversation customer_name
            await db.run(
              'UPDATE conversations SET customer_name = ? WHERE shop_id = ? AND line_user_id = ?',
              [profile.displayName, botId, lineUserId]
            );
          }
        } catch { /* non-fatal */ }
      })();
    }

    // Send LINE Notify to merchant when newly escalated
    if (escalated && !wasEscalated) {
      sendLineNotify(db, botId, lineUserId, userText).catch(e =>
        console.warn('[notify] LINE Notify failed:', e)
      );
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
    await db.run(
      `INSERT INTO payment_notifications
         (shop_id, payer_name, amount, transfer_date, bank_name, account_name, account_number, ref_number, status)
       VALUES (?, ?, ?, ?, ?, 'MeowChat', '-', ?, ?)`,
      [botId, lineUserId, amount ?? 0, date ?? new Date().toISOString().slice(0,10), bankName ?? '-', refNumber ?? null, status]
    );
    res.json({ ok: true, status });
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

    for (const { name, qty = 1 } of items) {
      const quantity = Math.max(1, parseInt(qty) || 1);
      // Case-insensitive partial match
      const product = await db.get(
        `SELECT * FROM products WHERE shop_id = ? AND LOWER(name) LIKE LOWER(?) AND status = 'active' LIMIT 1`,
        [botId, `%${name}%`]
      );
      if (!product) {
        return res.status(422).json({ error: `ไม่พบสินค้า: ${name}`, item: name });
      }
      const price = Number(product.price) || 0;
      computedTotal += price * quantity;
      resolvedItems.push({ productId: product.id, productName: product.name, quantity, price });
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

    const orderId = 'ord_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
          'UPDATE inventory SET quantity = MAX(0, quantity - ?), updated_at = ? WHERE id = ?',
          [ri.quantity, now, inv.id]
        );
      }
    }

    await db.run(
      `INSERT INTO orders (id, shop_id, customer_id, order_number, status, items, total_amount, payment_method, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, 'bot', ?, ?, ?)`,
      [
        orderId, botId, customer?.id ?? null, orderNumber, 'pending',
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

    // LINE Notify to merchant — fire-and-forget, don't block response
    (async () => {
      try {
        const shop = await db.get('SELECT line_notify_token, name FROM shops WHERE id = ?', [botId]);
        if (shop?.line_notify_token) {
          const itemLines = resolvedItems.map(i => `• ${i.productName} x${i.quantity} ฿${(i.price * i.quantity).toLocaleString()}`).join('\n');
          const msg = `\n🛒 ออเดอร์ใหม่ ${orderNumber}\nยอดรวม: ฿${computedTotal.toLocaleString()}\n${itemLines}${note ? `\nหมายเหตุ: ${note}` : ''}`;
          await fetch('https://notify-api.line.me/api/notify', {
            method: 'POST',
            headers: { Authorization: `Bearer ${shop.line_notify_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ message: msg }),
          });
        }
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

    // LINE Notify to merchant — fire-and-forget
    (async () => {
      try {
        const shop = await db.get('SELECT line_notify_token FROM shops WHERE id = ?', [botId]);
        if (shop?.line_notify_token) {
          const dateStr = datetime ? `\nวันเวลา: ${datetime}` : '';
          const msg = `\n📅 นัดหมายใหม่!\nบริการ: ${service}${dateStr}${note ? `\nหมายเหตุ: ${note}` : ''}`;
          await fetch('https://notify-api.line.me/api/notify', {
            method: 'POST',
            headers: { Authorization: `Bearer ${shop.line_notify_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ message: msg }),
          });
        }
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

async function sendLineNotify(db, shopId, lineUserId, lastMessage) {
  const shop = await db.get('SELECT line_notify_token FROM shops WHERE id = ?', [shopId]);
  const token = shop?.line_notify_token;
  if (!token) return;
  const text = `\n🔔 ลูกค้าขอคุยกับพนักงาน!\nLine ID: ${lineUserId}\nข้อความล่าสุด: "${lastMessage || ''}"`;
  await fetch('https://notify-api.line.me/api/notify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message: text }),
  });
  console.log(`[notify] LINE Notify sent for shop=${shopId}`);
}

// Trial Day-10 Reminder — runs every 24h, sends LINE Notify to shops expiring in 4 days
async function sendTrialReminders() {
  try {
    const db = getDb();
    if (!db) return;
    // Find shops where trial ends in 3–5 days (catches day 10 of 14-day trial)
    const shops = await db.all(`
      SELECT s.id, s.name, s.line_notify_token
      FROM shops s
      WHERE s.trial_ends_at IS NOT NULL
        AND s.trial_reminder_sent = FALSE
        AND s.trial_ends_at BETWEEN NOW() + INTERVAL '3 days' AND NOW() + INTERVAL '5 days'
    `);
    for (const shop of shops) {
      if (!shop.line_notify_token) continue;
      const daysLeft = 4;
      const msg = `\n⏰ ทดลองใช้ MeowChat เหลืออีก ${daysLeft} วัน!\n\nบอทของคุณตอบลูกค้าให้คุณทุกวัน อย่าให้มันหยุดทำงาน\n\n👉 Upgrade ที่ my.meowchat.store/subscription\n✅ Pro ฿376/เดือน — คุ้มกว่าจ้างพนักงานตอบ LINE`;
      try {
        await fetch('https://notify-api.line.me/api/notify', {
          method: 'POST',
          headers: { Authorization: `Bearer ${shop.line_notify_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ message: msg }),
        });
        await db.run(`UPDATE shops SET trial_reminder_sent = TRUE WHERE id = ?`, [shop.id]);
        console.log(`[trial-reminder] sent to shop=${shop.id}`);
      } catch (e) {
        console.error(`[trial-reminder] failed for shop=${shop.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[trial-reminder] scheduler error:', err.message);
  }
}

// Day-3 Activation Notify — check if bot ever responded; if not, prompt setup
async function sendDay3Notifications() {
  try {
    const db = getDb();
    if (!db) return;
    // Shops that signed up ~3 days ago and have LINE Notify token
    const shops = await db.all(`
      SELECT s.id, s.name, s.line_notify_token
      FROM shops s
      WHERE s.line_notify_token IS NOT NULL AND s.line_notify_token != ''
        AND s.created_at BETWEEN NOW() - INTERVAL '4 days' AND NOW() - INTERVAL '2 days'
        AND NOT EXISTS (
          SELECT 1 FROM conversations c WHERE c.shop_id = s.id LIMIT 1
        )
    `);
    for (const shop of shops) {
      const msg = `\n🐱 สวัสดีครับ! บอท MeowChat ของ "${shop.name}" ทำงานได้แล้วไหมครับ?\n\nถ้ายังไม่ได้ตั้งค่า webhook ไม่ต้องกังวล — เข้าไปที่ my.meowchat.store/bot แล้วทำตาม step-by-step ได้เลย ใช้เวลาแค่ 5 นาที\n\nมีปัญหาติดต่อ @MeowChatSupport ได้เลยครับ 🙏`;
      try {
        await fetch('https://notify-api.line.me/api/notify', {
          method: 'POST',
          headers: { Authorization: `Bearer ${shop.line_notify_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ message: msg }),
        });
        console.log(`[day3-notify] sent to shop=${shop.id}`);
      } catch (e) {
        console.error(`[day3-notify] failed for shop=${shop.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[day3-notify] error:', err.message);
  }
}

// Weekly Summary Digest — every Monday sends last 7 days stats via LINE Notify
async function sendWeeklySummary() {
  const now = new Date();
  if (now.getDay() !== 1) return; // Monday only
  try {
    const db = getDb();
    if (!db) return;
    const shops = await db.all(`
      SELECT s.id, s.name, s.line_notify_token
      FROM shops s
      WHERE s.line_notify_token IS NOT NULL AND s.line_notify_token != ''
    `);
    for (const shop of shops) {
      const stats = await db.get(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN escalated = 1 THEN 1 ELSE 0 END) as escalated
        FROM conversations
        WHERE shop_id = ?
          AND created_at >= NOW() - INTERVAL '7 days'
      `, [shop.id]);
      const total = stats?.total ?? 0;
      if (total === 0) continue; // no activity, skip
      const esc = stats?.escalated ?? 0;
      const aiRate = total > 0 ? Math.round(((total - esc) / total) * 100) : 0;
      const timeSaved = Math.round((total * 3) / 60);
      const msg = `\n📊 สรุปสัปดาห์ — "${shop.name}"\n\n🤖 บอทตอบแทนคุณ: ${total} ครั้ง\n⏰ ประหยัดเวลา: ~${timeSaved} ชั่วโมง\n✅ AI ตอบได้เอง: ${aiRate}%\n🔔 ส่งต่อพนักงาน: ${esc} ครั้ง\n\nดูรายละเอียดที่ my.meowchat.store 🐱`;
      try {
        await fetch('https://notify-api.line.me/api/notify', {
          method: 'POST',
          headers: { Authorization: `Bearer ${shop.line_notify_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ message: msg }),
        });
        console.log(`[weekly-summary] sent to shop=${shop.id}`);
      } catch (e) {
        console.error(`[weekly-summary] failed for shop=${shop.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[weekly-summary] error:', err.message);
  }
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
      SELECT id, name, line_notify_token
      FROM shops
      WHERE subscription_status = 'grace'
        AND grace_period_ends_at < NOW()
        AND bot_locked = FALSE
    `);
    for (const shop of expired) {
      await db.run(`UPDATE shops SET bot_locked = TRUE, subscription_status = 'expired' WHERE id = ?`, [shop.id]);
      // Notify owner
      if (shop.line_notify_token) {
        const msg = `\n🔒 บอท MeowChat ของ "${shop.name}" หยุดทำงานชั่วคราว\n\nกรุณา Upgrade เพื่อเปิดใช้งานอีกครั้ง\n👉 my.meowchat.store/subscription\nPro ฿376/เดือน`;
        fetch('https://notify-api.line.me/api/notify', {
          method: 'POST',
          headers: { Authorization: `Bearer ${shop.line_notify_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ message: msg }),
        }).catch(() => {});
      }
      console.log(`[state-machine] locked bot for shop=${shop.id}`);
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
  .then(() => { dbReady = true; })
  .catch(err => {
    console.error('❌ DB init failed:', err.message || err.code || String(err));
    // Don't exit — let the process stay up so Railway doesn't loop-restart
  });

module.exports = { app, lineConfig };
