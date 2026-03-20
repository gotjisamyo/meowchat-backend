const express = require('express');
const { processUserMessage } = require('../agent');

const router = express.Router();

// Chat endpoint - for testing AI
router.post('/chat', async (req, res) => {
  try {
    const { message, userId, shopId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const result = await processUserMessage(userId || 'test-user', message, shopId);

    res.json(result);
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

module.exports = router;
