const { getDb } = require('./db');

// Funnel event names
const EVENTS = {
  TRIAL_STARTED: 'trial_started',
  BOT_ACTIVATED: 'bot_activated',
  FIRST_REPLY: 'first_reply',
  UPGRADE_CLICKED: 'upgrade_clicked',
};

// Track a funnel event for a shop (fire-and-forget safe)
async function trackEvent(shopId, event, meta = null) {
  if (!shopId || !event) return;
  try {
    const db = getDb();
    // Only insert once per unique event per shop (idempotent)
    const existing = await db.get(
      'SELECT id FROM shop_events WHERE shop_id = ? AND event = ?',
      [shopId, event]
    );
    if (existing) return;
    await db.run(
      'INSERT INTO shop_events (shop_id, event, meta) VALUES (?, ?, ?)',
      [shopId, event, meta ? JSON.stringify(meta) : null]
    );
  } catch (err) {
    // Never throw — tracking must not break the main flow
    console.warn(`[events] failed to track ${event} for ${shopId}:`, err.message);
  }
}

module.exports = { trackEvent, EVENTS };
