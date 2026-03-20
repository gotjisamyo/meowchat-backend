const Stripe = require('stripe');
const { getDb } = require('../db');
const { authMiddleware } = require('../auth');
const { requireOwnedShop } = require('../middleware/shopAccess');

const SUBSCRIPTION_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
};

const PAYMENT_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some(column => column.name === columnName);

  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function initBillingTables() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      max_chats INTEGER NOT NULL,
      max_agents INTEGER NOT NULL,
      features TEXT,
      stripe_price_id TEXT,
      is_active INTEGER DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT NOT NULL,
      plan_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      start_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      end_date DATETIME,
      payment_method TEXT,
      payment_status TEXT DEFAULT 'pending',
      stripe_checkout_session_id TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_payment_intent_id TEXT,
      stripe_price_id TEXT,
      checkout_url TEXT,
      last_payment_error TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT NOT NULL,
      chats_count INTEGER DEFAULT 0,
      agents_count INTEGER DEFAULT 0,
      period_start DATETIME,
      period_end DATETIME,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  ensureColumn(db, 'plans', 'stripe_price_id', 'TEXT');
  ensureColumn(db, 'subscriptions', 'stripe_checkout_session_id', 'TEXT');
  ensureColumn(db, 'subscriptions', 'stripe_customer_id', 'TEXT');
  ensureColumn(db, 'subscriptions', 'stripe_subscription_id', 'TEXT');
  ensureColumn(db, 'subscriptions', 'stripe_payment_intent_id', 'TEXT');
  ensureColumn(db, 'subscriptions', 'stripe_price_id', 'TEXT');
  ensureColumn(db, 'subscriptions', 'checkout_url', 'TEXT');
  ensureColumn(db, 'subscriptions', 'last_payment_error', 'TEXT');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_checkout_session
    ON subscriptions(stripe_checkout_session_id)
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription
    ON subscriptions(stripe_subscription_id)
  `);

  const existingPlans = db.prepare('SELECT COUNT(*) as count FROM plans').get();
  if (existingPlans.count === 0) {
    const insertPlan = db.prepare(`
      INSERT INTO plans (name, price, max_chats, max_agents, features)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertPlan.run('Starter', 999, 500, 1, JSON.stringify([
      'ใช้งานได้ 1 Agent',
      '500 ข้อความ/เดือน',
      'รองรับ LINE Bot',
      'สถิติพื้นฐาน',
      'สนับสนุนทาง Email'
    ]));

    insertPlan.run('Pro', 2999, 5000, 5, JSON.stringify([
      'ใช้งานได้ 5 Agents',
      '5,000 ข้อความ/เดือน',
      'รองรับ LINE Bot',
      'สถิติขั้นสูง',
      'AI Auto Reply',
      'สนับสนุนทาง Email & Chat'
    ]));

    insertPlan.run('Enterprise', 9999, -1, -1, JSON.stringify([
      'ใช้งานได้ไม่จำกัด Agents',
      'ข้อความไม่จำกัด',
      'รองรับ LINE Bot & Multi-channel',
      'สถิติขั้นสูง & Analytics',
      'AI Auto Reply',
      'API Access',
      'ลำดับชั้นผู้ใช้งาน',
      'สนับสนุน 24/7'
    ]));
  }
}

function normalizePlan(plan) {
  return {
    ...plan,
    features: JSON.parse(plan.features || '[]'),
    isUnlimitedChats: plan.max_chats === -1,
    isUnlimitedAgents: plan.max_agents === -1
  };
}

function getPlans() {
  const db = getDb();
  const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC').all();
  return plans.map(normalizePlan);
}

function getPlanById(planId) {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  return plan ? normalizePlan(plan) : null;
}

function getSubscription(shopId) {
  const db = getDb();

  const subscription = db.prepare(`
    SELECT s.*, p.name as plan_name, p.price, p.max_chats, p.max_agents, p.features
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.shop_id = ?
    ORDER BY s.createdAt DESC
    LIMIT 1
  `).get(shopId);

  if (!subscription) return null;

  return {
    ...subscription,
    features: JSON.parse(subscription.features || '[]'),
    isUnlimitedChats: subscription.max_chats === -1,
    isUnlimitedAgents: subscription.max_agents === -1
  };
}

function ensureUsageTracking(shopId, periodEndIso) {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id FROM usage_tracking
    WHERE shop_id = ?
    ORDER BY createdAt DESC
    LIMIT 1
  `).get(shopId);

  if (existing) {
    db.prepare(`
      UPDATE usage_tracking
      SET chats_count = 0,
          agents_count = 0,
          period_start = datetime('now'),
          period_end = ?,
          updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(periodEndIso, existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO usage_tracking (shop_id, chats_count, agents_count, period_start, period_end)
    VALUES (?, 0, 0, datetime('now'), ?)
  `).run(shopId, periodEndIso);

  return result.lastInsertRowid;
}

function createPendingSubscription({ shopId, planId, paymentMethod = 'stripe', stripeCheckoutSessionId, checkoutUrl, stripePriceId }) {
  const db = getDb();
  const plan = getPlanById(planId);
  if (!plan) throw new Error('Plan not found');

  const existing = stripeCheckoutSessionId
    ? db.prepare('SELECT * FROM subscriptions WHERE stripe_checkout_session_id = ?').get(stripeCheckoutSessionId)
    : null;

  if (existing) {
    db.prepare(`
      UPDATE subscriptions
      SET shop_id = ?,
          plan_id = ?,
          payment_method = ?,
          payment_status = ?,
          stripe_price_id = ?,
          checkout_url = ?,
          updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      shopId,
      planId,
      paymentMethod,
      PAYMENT_STATUS.PENDING,
      stripePriceId || plan.stripe_price_id || null,
      checkoutUrl || null,
      existing.id
    );

    return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO subscriptions (
      shop_id,
      plan_id,
      status,
      payment_method,
      payment_status,
      stripe_checkout_session_id,
      stripe_price_id,
      checkout_url
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    shopId,
    planId,
    SUBSCRIPTION_STATUS.PENDING,
    paymentMethod,
    PAYMENT_STATUS.PENDING,
    stripeCheckoutSessionId || null,
    stripePriceId || plan.stripe_price_id || null,
    checkoutUrl || null
  );

  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(result.lastInsertRowid);
}

function activateSubscriptionFromStripe({
  shopId,
  planId,
  stripeCheckoutSessionId,
  stripeCustomerId,
  stripeSubscriptionId,
  stripePaymentIntentId,
  stripePriceId,
  periodEnd,
  paymentMethod = 'stripe'
}) {
  if (!shopId || !planId) {
    throw new Error(`activateSubscriptionFromStripe: missing shopId (${shopId}) or planId (${planId})`);
  }
  const db = getDb();
  const plan = getPlanById(planId);
  if (!plan) {
    throw new Error('Plan not found for Stripe activation');
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE subscriptions
      SET status = ?, payment_status = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE shop_id = ? AND status = ?
        AND (stripe_subscription_id IS NULL OR stripe_subscription_id != ?)
    `).run(
      SUBSCRIPTION_STATUS.CANCELLED,
      PAYMENT_STATUS.CANCELLED,
      shopId,
      SUBSCRIPTION_STATUS.ACTIVE,
      stripeSubscriptionId || ''
    );

    const existing = stripeCheckoutSessionId
      ? db.prepare('SELECT id FROM subscriptions WHERE stripe_checkout_session_id = ?').get(stripeCheckoutSessionId)
      : stripeSubscriptionId
        ? db.prepare('SELECT id FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubscriptionId)
        : null;

    const endDateIso = periodEnd
      ? new Date(periodEnd * 1000).toISOString()
      : (() => {
          const nextMonth = new Date();
          nextMonth.setMonth(nextMonth.getMonth() + 1);
          return nextMonth.toISOString();
        })();

    if (existing) {
      db.prepare(`
        UPDATE subscriptions
        SET shop_id = ?,
            plan_id = ?,
            status = ?,
            start_date = CURRENT_TIMESTAMP,
            end_date = ?,
            payment_method = ?,
            payment_status = ?,
            stripe_customer_id = ?,
            stripe_subscription_id = ?,
            stripe_payment_intent_id = ?,
            stripe_price_id = ?,
            last_payment_error = NULL,
            updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        shopId,
        planId,
        SUBSCRIPTION_STATUS.ACTIVE,
        endDateIso,
        paymentMethod,
        PAYMENT_STATUS.COMPLETED,
        stripeCustomerId || null,
        stripeSubscriptionId || null,
        stripePaymentIntentId || null,
        stripePriceId || plan.stripe_price_id || null,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO subscriptions (
          shop_id,
          plan_id,
          status,
          start_date,
          end_date,
          payment_method,
          payment_status,
          stripe_checkout_session_id,
          stripe_customer_id,
          stripe_subscription_id,
          stripe_payment_intent_id,
          stripe_price_id
        )
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        shopId,
        planId,
        SUBSCRIPTION_STATUS.ACTIVE,
        endDateIso,
        paymentMethod,
        PAYMENT_STATUS.COMPLETED,
        stripeCheckoutSessionId || null,
        stripeCustomerId || null,
        stripeSubscriptionId || null,
        stripePaymentIntentId || null,
        stripePriceId || plan.stripe_price_id || null
      );
    }

    ensureUsageTracking(shopId, endDateIso);
  })();

  return getSubscription(shopId);
}

function markSubscriptionPaymentFailed({ stripeCheckoutSessionId, stripeSubscriptionId, errorMessage }) {
  const db = getDb();

  let subscription = null;
  if (stripeCheckoutSessionId) {
    subscription = db.prepare('SELECT * FROM subscriptions WHERE stripe_checkout_session_id = ?').get(stripeCheckoutSessionId);
  }
  if (!subscription && stripeSubscriptionId) {
    subscription = db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubscriptionId);
  }
  if (!subscription) return null;

  db.prepare(`
    UPDATE subscriptions
    SET status = ?,
        payment_status = ?,
        last_payment_error = ?,
        updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    SUBSCRIPTION_STATUS.FAILED,
    PAYMENT_STATUS.FAILED,
    errorMessage || 'Stripe payment failed',
    subscription.id
  );

  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscription.id);
}

function cancelSubscriptionByStripeSubscriptionId(stripeSubscriptionId) {
  const db = getDb();
  const subscription = db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubscriptionId);
  if (!subscription) return null;

  db.prepare(`
    UPDATE subscriptions
    SET status = ?, payment_status = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(SUBSCRIPTION_STATUS.CANCELLED, PAYMENT_STATUS.CANCELLED, subscription.id);

  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscription.id);
}

function getUsageStats(shopId) {
  const db = getDb();
  const subscription = getSubscription(shopId);
  const usage = db.prepare(`
    SELECT * FROM usage_tracking
    WHERE shop_id = ?
    ORDER BY createdAt DESC
    LIMIT 1
  `).get(shopId);

  if (!usage) {
    return {
      chats: 0,
      agents: 0,
      maxChats: subscription?.max_chats || 0,
      maxAgents: subscription?.max_agents || 0,
      periodStart: null,
      periodEnd: null,
      isUnlimitedChats: subscription?.max_chats === -1,
      isUnlimitedAgents: subscription?.max_agents === -1
    };
  }

  return {
    chats: usage.chats_count,
    agents: usage.agents_count,
    maxChats: subscription?.max_chats || 0,
    maxAgents: subscription?.max_agents || 0,
    periodStart: usage.period_start,
    periodEnd: usage.period_end,
    isUnlimitedChats: subscription?.max_chats === -1,
    isUnlimitedAgents: subscription?.max_agents === -1
  };
}

function updateUsage(shopId, type, count = 1) {
  const db = getDb();
  const field = type === 'chat' ? 'chats_count' : 'agents_count';
  const existing = db.prepare(`
    SELECT id FROM usage_tracking
    WHERE shop_id = ? AND period_end > datetime('now')
    ORDER BY createdAt DESC LIMIT 1
  `).get(shopId);

  if (existing) {
    db.prepare(`
      UPDATE usage_tracking
      SET ${field} = ${field} + ?, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(count, existing.id);
    return;
  }

  db.prepare(`
    INSERT INTO usage_tracking (shop_id, ${field}, period_start, period_end)
    VALUES (?, ?, datetime('now'), datetime('now', '+1 month'))
  `).run(shopId, count);
}

function resolveOwnedShopFromRequest(req, res) {
  const shopId = req.query.shopId || req.body.shopId || req.headers['x-shop-id'];

  if (!shopId) {
    res.status(400).json({ success: false, error: 'shopId is required' });
    return null;
  }

  return requireOwnedShop(req, res, shopId);
}

async function createCheckoutSession({ shop, plan, successUrl, cancelUrl, customerEmail }) {
  const stripe = getStripeClient();
  const currency = (process.env.STRIPE_CURRENCY || 'thb').toLowerCase();
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    success_url: successUrl || `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl || `${appUrl}/billing/cancel`,
    customer_email: customerEmail || undefined,
    allow_promotion_codes: true,
    metadata: {
      shopId: String(shop.id),
      planId: String(plan.id)
    },
    subscription_data: {
      metadata: {
        shopId: String(shop.id),
        planId: String(plan.id)
      }
    },
    line_items: [
      plan.stripe_price_id
        ? {
            price: plan.stripe_price_id,
            quantity: 1
          }
        : {
            price_data: {
              currency,
              recurring: { interval: 'month' },
              product_data: {
                name: `MeowChat ${plan.name}`,
                description: `${plan.name} plan for ${shop.name}`
              },
              unit_amount: Math.round(Number(plan.price) * 100)
            },
            quantity: 1
          }
    ]
  });

  return session;
}

async function createCheckoutSessionResponse({ shop, planId, successUrl, cancelUrl, customerEmail }) {
  if (!planId) {
    throw new Error('Plan ID is required');
  }

  const plan = getPlanById(planId);
  if (!plan) {
    throw new Error('Plan not found');
  }

  const session = await createCheckoutSession({
    shop,
    plan,
    successUrl,
    cancelUrl,
    customerEmail
  });

  const subscription = createPendingSubscription({
    shopId: shop.id,
    planId: plan.id,
    paymentMethod: 'stripe',
    stripeCheckoutSessionId: session.id,
    checkoutUrl: session.url,
    stripePriceId: plan.stripe_price_id || null
  });

  return {
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    subscription
  };
}

async function handleStripeWebhook(req, res) {
  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return res.status(500).json({ success: false, error: 'STRIPE_WEBHOOK_SECRET is not configured' });
    }

    if (!req.rawBody) {
      return res.status(400).json({ success: false, error: 'Webhook raw body not available — ensure the route is registered before body-parser overrides the verify callback' });
    }

    const stripe = getStripeClient();
    const signature = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        let csShopId = session.metadata?.shopId;
        let csPlanId = Number(session.metadata?.planId) || 0;

        // Fallback: resolve from the pending subscription we created at checkout time
        if ((!csShopId || !csPlanId) && session.id) {
          const db = getDb();
          const existing = db.prepare('SELECT * FROM subscriptions WHERE stripe_checkout_session_id = ?').get(session.id);
          if (existing) {
            csShopId = csShopId || existing.shop_id;
            csPlanId = csPlanId || existing.plan_id;
          }
        }

        if (!csShopId || !csPlanId) {
          console.warn('[billing] checkout.session.completed: could not resolve shopId/planId for session', session.id);
          break; // ack 200 to Stripe — unrecoverable without metadata
        }

        // line_items are not expanded in webhook payloads; stripePriceId comes from the pending subscription record
        activateSubscriptionFromStripe({
          shopId: csShopId,
          planId: csPlanId,
          stripeCheckoutSessionId: session.id,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          stripePaymentIntentId: session.payment_intent,
          stripePriceId: null,
          periodEnd: null,
          paymentMethod: 'stripe'
        });
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const line = invoice.lines?.data?.[0];

        // Metadata can be on the line item, on subscription_details (v2), or on parent.subscription_details (newer API)
        let shopId = line?.metadata?.shopId
          || invoice.subscription_details?.metadata?.shopId
          || invoice.parent?.subscription_details?.metadata?.shopId;
        let planId = Number(
          line?.metadata?.planId
          || invoice.subscription_details?.metadata?.planId
          || invoice.parent?.subscription_details?.metadata?.planId
        ) || 0;

        // Fallback: look up by stripeSubscriptionId in our DB (handles renewal invoices without metadata)
        if ((!shopId || !planId) && invoice.subscription) {
          const db = getDb();
          const existing = db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').get(invoice.subscription);
          if (existing) {
            shopId = shopId || existing.shop_id;
            planId = planId || existing.plan_id;
          }
        }

        if (!shopId || !planId) {
          console.warn('[billing] invoice.payment_succeeded: could not resolve shopId/planId for invoice', invoice.id);
          break;
        }

        activateSubscriptionFromStripe({
          shopId,
          planId,
          stripeCustomerId: invoice.customer,
          stripeSubscriptionId: invoice.subscription,
          stripePaymentIntentId: invoice.payment_intent,
          stripePriceId: line?.price?.id || null,
          periodEnd: line?.period?.end || null,
          paymentMethod: 'stripe'
        });
        break;
      }

      case 'checkout.session.async_payment_failed': {
        const session = event.data.object;
        markSubscriptionPaymentFailed({
          stripeCheckoutSessionId: session.id,
          stripeSubscriptionId: session.subscription,
          errorMessage: 'Stripe checkout async payment failed'
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        markSubscriptionPaymentFailed({
          stripeSubscriptionId: invoice.subscription,
          errorMessage: invoice.last_finalization_error?.message || 'Invoice payment failed'
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        cancelSubscriptionByStripeSubscriptionId(subscription.id);
        break;
      }

      case 'customer.subscription.updated': {
        // Keep end_date in sync when Stripe renews or modifies the subscription period
        const sub = event.data.object;
        if (sub.status === 'active' && sub.current_period_end) {
          const db = getDb();
          const existing = db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').get(sub.id);
          if (existing) {
            const endDateIso = new Date(sub.current_period_end * 1000).toISOString();
            db.prepare(`
              UPDATE subscriptions
              SET end_date = ?, status = ?, updatedAt = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(endDateIso, SUBSCRIPTION_STATUS.ACTIVE, existing.id);
          }
        }
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
}

function setupBillingRoutes(app) {
  initBillingTables();

  app.post('/api/billing/webhook', handleStripeWebhook);

  app.get('/api/plans', authMiddleware, (req, res) => {
    try {
      const plans = getPlans();
      res.json({ success: true, data: plans });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/billing', authMiddleware, (req, res) => {
    try {
      if (!resolveOwnedShopFromRequest(req, res)) return;

      res.json({
        success: true,
        data: {
          subscription: getSubscription(req.shopId),
          usage: getUsageStats(req.shopId)
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/billing/checkout-session', authMiddleware, async (req, res) => {
    try {
      const { planId, successUrl, cancelUrl, customerEmail } = req.body;
      const shop = resolveOwnedShopFromRequest(req, res);
      if (!shop) return;

      const data = await createCheckoutSessionResponse({
        shop,
        planId,
        successUrl,
        cancelUrl,
        customerEmail: customerEmail || req.user?.email
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Create checkout session error:', error);
      const statusCode = error.message === 'Plan not found' ? 404 : 400;
      res.status(statusCode).json({ success: false, error: error.message });
    }
  });

  app.post('/api/billing/subscribe', authMiddleware, async (req, res) => {
    try {
      const { planId, successUrl, cancelUrl, customerEmail } = req.body;
      const shop = resolveOwnedShopFromRequest(req, res);
      if (!shop) return;

      const data = await createCheckoutSessionResponse({
        shop,
        planId,
        successUrl,
        cancelUrl,
        customerEmail: customerEmail || req.user?.email
      });

      res.json({
        success: true,
        data: {
          ...data,
          message: 'Stripe checkout session created successfully'
        }
      });
    } catch (error) {
      console.error('Create subscription checkout error:', error);
      const statusCode = error.message === 'Plan not found' ? 404 : 400;
      res.status(statusCode).json({ success: false, error: error.message });
    }
  });

  app.post('/api/billing/checkout', authMiddleware, async (req, res) => {
    try {
      const { planId, successUrl, cancelUrl, customerEmail } = req.body;
      const shop = resolveOwnedShopFromRequest(req, res);
      if (!shop) return;

      const data = await createCheckoutSessionResponse({
        shop,
        planId,
        successUrl,
        cancelUrl,
        customerEmail: customerEmail || req.user?.email
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Create checkout error:', error);
      const statusCode = error.message === 'Plan not found' ? 404 : 400;
      res.status(statusCode).json({ success: false, error: error.message });
    }
  });

  app.get('/api/billing/subscription', authMiddleware, (req, res) => {
    try {
      if (!resolveOwnedShopFromRequest(req, res)) return;
      const subscription = getSubscription(req.shopId);
      res.json({ success: true, data: subscription });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/billing/usage', authMiddleware, (req, res) => {
    try {
      if (!resolveOwnedShopFromRequest(req, res)) return;
      res.json({ success: true, data: getUsageStats(req.shopId) });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = {
  setupBillingRoutes,
  initBillingTables,
  getPlans,
  getPlanById,
  getSubscription,
  createPendingSubscription,
  activateSubscriptionFromStripe,
  markSubscriptionPaymentFailed,
  cancelSubscriptionByStripeSubscriptionId,
  getUsageStats,
  updateUsage,
  handleStripeWebhook
};
