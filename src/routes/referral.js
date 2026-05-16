const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');

const router = express.Router();

// 10 clicks per IP per hour — prevents click inflation
const clickLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Generate unique referral code for a shop
function generateCode(shopId) {
  const base = shopId.toString().replace(/[^a-z0-9]/gi, '').toUpperCase().slice(-6);
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `MC${base}${rand}`;
}

// GET /api/referral/my — get or create referral code for current user's shop
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const shops = await db.all('SELECT id FROM shops WHERE user_id = ? LIMIT 1', [req.userId]);
    if (!shops.length) return res.status(404).json({ error: 'No shop found' });
    const shopId = shops[0].id;

    let code = await db.get('SELECT * FROM referral_codes WHERE shop_id = ?', [shopId]);
    if (!code) {
      const newCode = generateCode(shopId);
      await db.run(
        'INSERT INTO referral_codes (shop_id, code) VALUES (?, ?)',
        [shopId, newCode]
      );
      code = await db.get('SELECT * FROM referral_codes WHERE shop_id = ?', [shopId]);
    }

    const conversions = await db.all(
      'SELECT * FROM referral_conversions WHERE referrer_shop_id = ? ORDER BY created_at DESC',
      [shopId]
    );

    res.json({
      code: code.code,
      clicks: code.clicks,
      conversions: code.conversions,
      rewards_earned: conversions.filter(c => c.rewarded).length,
      link: `https://my.meowchat.store/onboarding?ref=${code.code}`,
    });
  } catch (err) {
    console.error('Referral my error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/referral/discount — check if current shop is eligible for 20% first-payment discount
router.get('/discount', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const shops = await db.all('SELECT id FROM shops WHERE user_id = ? LIMIT 1', [req.userId]);
    if (!shops.length) return res.json({ eligible: false });
    const shopId = shops[0].id;

    const conversion = await db.get(
      'SELECT id FROM referral_conversions WHERE referred_shop_id = ?',
      [shopId]
    );
    if (!conversion) return res.json({ eligible: false });

    // Only eligible if no approved payments yet
    const paid = await db.get(
      `SELECT COUNT(*) as cnt FROM payment_notifications WHERE shop_id = ? AND status = 'approved'`,
      [shopId]
    );
    res.json({ eligible: paid.cnt === 0, discount: 20 });
  } catch (err) {
    console.error('Referral discount error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/referral/click — track click (called from onboarding page load)
router.post('/click', clickLimiter, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const db = getDb();
    await db.run('UPDATE referral_codes SET clicks = clicks + 1 WHERE code = ?', [code]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/referral/convert — called after new shop created via referral link
router.post('/convert', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const db = getDb();

    const referralCode = await db.get('SELECT * FROM referral_codes WHERE code = ?', [code]);
    if (!referralCode) return res.status(404).json({ error: 'Invalid referral code' });

    // Get referred shop (current user's shop)
    const shops = await db.all('SELECT id FROM shops WHERE user_id = ? LIMIT 1', [req.userId]);
    if (!shops.length) return res.status(404).json({ error: 'No shop found' });
    const referredShopId = shops[0].id;

    // Prevent self-referral
    if (referralCode.shop_id === referredShopId) {
      return res.status(400).json({ error: 'Cannot refer yourself' });
    }

    // Prevent duplicate conversion
    const existing = await db.get(
      'SELECT id FROM referral_conversions WHERE referred_shop_id = ?',
      [referredShopId]
    );
    if (existing) return res.json({ ok: true, already_tracked: true });

    // Record conversion
    await db.run(
      'INSERT INTO referral_conversions (referrer_shop_id, referred_shop_id, code) VALUES (?, ?, ?)',
      [referralCode.shop_id, referredShopId, code]
    );
    await db.run('UPDATE referral_codes SET conversions = conversions + 1 WHERE code = ?', [code]);

    console.log(`[referral] conversion: code=${code} referrer=${referralCode.shop_id} referred=${referredShopId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Referral convert error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Shared logic — also called directly from billing.js on Stripe payment success
async function applyReferralReward(referredShopId) {
  const db = getDb();
  const conversion = await db.get(
    'SELECT * FROM referral_conversions WHERE referred_shop_id = ? AND rewarded = FALSE',
    [referredShopId]
  );
  if (!conversion) return false;

  const referrerShop = await db.get('SELECT * FROM shops WHERE id = ?', [conversion.referrer_shop_id]);
  if (referrerShop) {
    const base = referrerShop.trial_ends_at ? new Date(referrerShop.trial_ends_at) : new Date();
    const newEndsAt = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
    await db.run(
      `UPDATE shops SET trial_ends_at = ?, subscription_status = 'trial', bot_locked = FALSE, trial_reminder_sent = FALSE WHERE id = ?`,
      [newEndsAt.toISOString(), conversion.referrer_shop_id]
    );
    console.log(`[referral] shop=${referrerShop.id} (${referrerShop.name}) extended to ${newEndsAt.toLocaleDateString('th-TH')}`);
  }

  await db.run('UPDATE referral_conversions SET rewarded = TRUE WHERE id = ?', [conversion.id]);
  console.log(`[referral] rewarded referrer=${conversion.referrer_shop_id}`);
  return true;
}

// POST /api/referral/reward — internal HTTP endpoint (kept for manual calls)
router.post('/reward', async (req, res) => {
  const key = req.headers['x-internal-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { referred_shop_id } = req.body;
    if (!referred_shop_id) return res.status(400).json({ error: 'referred_shop_id required' });
    const rewarded = await applyReferralReward(referred_shop_id);
    res.json({ ok: true, rewarded });
  } catch (err) {
    console.error('Referral reward error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.applyReferralReward = applyReferralReward;
