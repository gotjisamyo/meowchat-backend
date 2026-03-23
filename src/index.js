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
    if (req.originalUrl.startsWith('/api/billing/webhook')) {
      req.rawBody = Buffer.from(buf);
    }
  }
}));
app.use(express.urlencoded({ extended: true }));

// LINE Bot SDK configuration
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// LINE webhook handler (only register if credentials are provided)
if (lineConfig.channelAccessToken && lineConfig.channelSecret) {
  app.post('/api/line/webhook', line.middleware(lineConfig), async (req, res) => {
    try {
      const events = req.body.events;
      const results = await Promise.all(
        events.map(event => handleLineEvent(event, lineConfig))
      );
      res.json({ success: true, results });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
} else {
  console.log('LINE credentials not configured - webhook disabled');
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

// LINE credential test — alias /api/line/test → /api/bots/line-test (with auth)
app.post('/api/line/test', authMiddleware, (req, res, next) => {
  req.url = '/line-test';
  botsRouter(req, res, next);
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
