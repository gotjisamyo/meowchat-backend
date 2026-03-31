require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const line = require('@line/bot-sdk');
const { initDatabase } = require('./db');
const { handleLineEvent } = require('./lineHandler');
const { setupRoutes } = require('./routes');
const { setupBillingRoutes } = require('./routes/billing');
const { authMiddleware } = require('./auth');
const { requireOwnedShop } = require('./middleware/shopAccess');

const app = express();

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
        // allow requests with no origin (mobile apps, curl) or matching origins
        if (!origin || allowedOrigins.some(o => origin.startsWith(o))) {
          cb(null, true);
        } else {
          cb(new Error(`CORS blocked: ${origin}`));
        }
      }
    : true,
  credentials: true
}));
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
app.use('/api/shops', shopRoutes);
app.use('/api/products', productRoutes);
app.use('/api/marketing', require('./routes/marketing'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/crm', require('./routes/crm'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/team', require('./routes/team'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/admin', require('./routes/admin'));

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
app.post('/api/internal/log', async (req, res) => {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { botId, lineUserId, userText, botReply } = req.body;
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
    if (!conv) {
      const result = await db.run(
        `INSERT INTO conversations (shop_id, line_user_id, customer_name, status, escalated)
         VALUES (?, ?, ?, 'active', 0)`,
        [botId, lineUserId, lineUserId]
      );
      conv = { id: result.lastID, escalated: 0 };
    } else {
      await db.run(
        'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [conv.id]
      );
    }

    // Save both turns as messages
    await db.run(
      'INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, ?, ?)',
      [conv.id, 'user', userText]
    );
    await db.run(
      'INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, ?, ?)',
      [conv.id, 'assistant', botReply]
    );

    res.json({ ok: true, conversationId: conv.id });
  } catch (err) {
    console.error('[internal/log] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Chat API - Direct
const { processUserMessage } = require('./agent');
app.post('/api/chat', authMiddleware, async (req, res) => {
  try {
    const { message, shopId, businessType, aiPersonality, aiResponseStyle, aiCustomKnowledge } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
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
