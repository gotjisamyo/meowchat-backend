require('dotenv').config();
const express = require('express');
const cors = require('cors');
const line = require('@line/bot-sdk');
const { initDatabase } = require('./db');
const { handleLineEvent } = require('./lineHandler');
const { setupRoutes } = require('./routes');
const { setupBillingRoutes } = require('./routes/billing');
const { authMiddleware } = require('./auth');
const { requireOwnedShop } = require('./middleware/shopAccess');

const app = express();

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.FRONTEND_URL || 'https://app.meowchat.store', 'https://meowchat.store']
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

// Initialize database
initDatabase();

// LINE webhook handler
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    if (!requireOwnedShop(req, res, shopId)) {
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MeowChat Backend running on port ${PORT}`);
});

module.exports = { app, lineConfig };
