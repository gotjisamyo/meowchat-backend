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

// All billing tables (plans, subscriptions, usage_tracking) are created in initDatabase().
// ensureColumn calls are also handled there via ADD COLUMN IF NOT EXISTS.

function initBillingTables() {
  // No-op: tables are initialized in initDatabase()
}

function normalizePlan(plan) {
  return {
    ...plan,
    features: JSON.parse(plan.features || '[]'),
    isUnlimitedChats: plan.max_chats === -1,
    isUnlimitedAgents: plan.max_agents === -1
  };
}

async function getPlans() {
  const db = getDb();
  const plans = await db.all('SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC');
  return plans.map(normalizePlan);
}

async function getPlanById(planId) {
  const db = getDb();
  const plan = await db.get('SELECT * FROM plans WHERE id = ?', [planId]);
  return plan ? normalizePlan(plan) : null;
}

async function getSubscription(shopId) {
  const db = getDb();

  const subscription = await db.get(`
    SELECT s.*, p.name as plan_name, p.price, p.max_chats, p.max_agents, p.features
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.shop_id = ?
    ORDER BY s."createdAt" DESC
    LIMIT 1
  `, [shopId]);

  if (!subscription) return null;

  return {
    ...subscription,
    features: JSON.parse(subscription.features || '[]'),
    isUnlimitedChats: subscription.max_chats === -1,
    isUnlimitedAgents: subscription.max_agents === -1
  };
}

async function ensureUsageTracking(shopId, periodEndIso) {
  const db = getDb();
  const existing = await db.get(`
    SELECT id FROM usage_tracking
    WHERE shop_id = ?
    ORDER BY "createdAt" DESC
    LIMIT 1
  `, [shopId]);

  if (existing) {
    await db.run(`
      UPDATE usage_tracking
      SET chats_count = 0,
          agents_count = 0,
          period_start = NOW(),
          period_end = ?,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [periodEndIso, existing.id]);
    return existing.id;
  }

  const result = await db.run(`
    INSERT INTO usage_tracking (shop_id, chats_count, agents_count, period_start, period_end)
    VALUES (?, 0, 0, NOW(), ?) RETURNING id
  `, [shopId, periodEndIso]);

  return result.lastInsertRowid;
}

async function createPendingSubscription({ shopId, planId, paymentMethod = 'stripe', stripeCheckoutSessionId, checkoutUrl, stripePriceId }) {
  const db = getDb();
  const plan = await getPlanById(planId);
  if (!plan) throw new Error('Plan not found');

  const existing = stripeCheckoutSessionId
    ? await db.get('SELECT * FROM subscriptions WHERE stripe_checkout_session_id = ?', [stripeCheckoutSessionId])
    : null;

  if (existing) {
    await db.run(`
      UPDATE subscriptions
      SET shop_id = ?,
          plan_id = ?,
          payment_method = ?,
          payment_status = ?,
          stripe_price_id = ?,
          checkout_url = ?,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      shopId,
      planId,
      paymentMethod,
      PAYMENT_STATUS.PENDING,
      stripePriceId || plan.stripe_price_id || null,
      checkoutUrl || null,
      existing.id
    ]);

    return db.get('SELECT * FROM subscriptions WHERE id = ?', [existing.id]);
  }

  const result = await db.run(`
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `, [
    shopId,
    planId,
    SUBSCRIPTION_STATUS.PENDING,
    paymentMethod,
    PAYMENT_STATUS.PENDING,
    stripeCheckoutSessionId || null,
    stripePriceId || plan.stripe_price_id || null,
    checkoutUrl || null
  ]);

  return db.get('SELECT * FROM subscriptions WHERE id = ?', [result.lastInsertRowid]);
}

async function activateSubscriptionFromStripe({
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
  const plan = await getPlanById(planId);
  if (!plan) {
    throw new Error('Plan not found for Stripe activation');
  }

  // Cancel other active subscriptions for this shop (except the one we're about to activate)
  await db.run(`
    UPDATE subscriptions
    SET status = ?, payment_status = ?, "updatedAt" = CURRENT_TIMESTAMP
    WHERE shop_id = ? AND status = ?
      AND (stripe_subscription_id IS NULL OR stripe_subscription_id != ?)
  `, [
    SUBSCRIPTION_STATUS.CANCELLED,
    PAYMENT_STATUS.CANCELLED,
    shopId,
    SUBSCRIPTION_STATUS.ACTIVE,
    stripeSubscriptionId || ''
  ]);

  const existing = stripeCheckoutSessionId
    ? await db.get('SELECT id FROM subscriptions WHERE stripe_checkout_session_id = ?', [stripeCheckoutSessionId])
    : stripeSubscriptionId
      ? await db.get('SELECT id FROM subscriptions WHERE stripe_subscription_id = ?', [stripeSubscriptionId])
      : null;

  const endDateIso = periodEnd
    ? new Date(periodEnd * 1000).toISOString()
    : (() => {
        const nextMonth = new Date();
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        return nextMonth.toISOString();
      })();

  if (existing) {
    await db.run(`
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
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
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
    ]);
  } else {
    await db.run(`
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
    `, [
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
    ]);
  }

  await ensureUsageTracking(shopId, endDateIso);

  return getSubscription(shopId);
}

async function markSubscriptionPaymentFailed({ stripeCheckoutSessionId, stripeSubscriptionId, errorMessage }) {
  const db = getDb();

  let subscription = null;
  if (stripeCheckoutSessionId) {
    subscription = await db.get('SELECT * FROM subscriptions WHERE stripe_checkout_session_id = ?', [stripeCheckoutSessionId]);
  }
  if (!subscription && stripeSubscriptionId) {
    subscription = await db.get('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?', [stripeSubscriptionId]);
  }
  if (!subscription) return null;

  await db.run(`
    UPDATE subscriptions
    SET status = ?,
        payment_status = ?,
        last_payment_error = ?,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    SUBSCRIPTION_STATUS.FAILED,
    PAYMENT_STATUS.FAILED,
    errorMessage || 'Stripe payment failed',
    subscription.id
  ]);

  return db.get('SELECT * FROM subscriptions WHERE id = ?', [subscription.id]);
}

async function cancelSubscriptionByStripeSubscriptionId(stripeSubscriptionId) {
  const db = getDb();
  const subscription = await db.get('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?', [stripeSubscriptionId]);
  if (!subscription) return null;

  await db.run(`
    UPDATE subscriptions
    SET status = ?, payment_status = ?, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [SUBSCRIPTION_STATUS.CANCELLED, PAYMENT_STATUS.CANCELLED, subscription.id]);

  return db.get('SELECT * FROM subscriptions WHERE id = ?', [subscription.id]);
}

async function getUsageStats(shopId) {
  const db = getDb();
  const subscription = await getSubscription(shopId);
  const usage = await db.get(`
    SELECT * FROM usage_tracking
    WHERE shop_id = ?
    ORDER BY "createdAt" DESC
    LIMIT 1
  `, [shopId]);

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

async function updateUsage(shopId, type, count = 1) {
  const db = getDb();
  const field = type === 'chat' ? 'chats_count' : 'agents_count';
  const existing = await db.get(`
    SELECT id FROM usage_tracking
    WHERE shop_id = ? AND period_end > NOW()
    ORDER BY "createdAt" DESC LIMIT 1
  `, [shopId]);

  if (existing) {
    await db.run(`
      UPDATE usage_tracking
      SET ${field} = ${field} + ?, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [count, existing.id]);
    return;
  }

  await db.run(`
    INSERT INTO usage_tracking (shop_id, ${field}, period_start, period_end)
    VALUES (?, ?, NOW(), NOW() + INTERVAL '1 month')
  `, [shopId, count]);
}

async function resolveOwnedShopFromRequest(req, res) {
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

  const plan = await getPlanById(planId);
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

  const subscription = await createPendingSubscription({
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
          const existing = await db.get('SELECT * FROM subscriptions WHERE stripe_checkout_session_id = ?', [session.id]);
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
        await activateSubscriptionFromStripe({
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
          const existing = await db.get('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?', [invoice.subscription]);
          if (existing) {
            shopId = shopId || existing.shop_id;
            planId = planId || existing.plan_id;
          }
        }

        if (!shopId || !planId) {
          console.warn('[billing] invoice.payment_succeeded: could not resolve shopId/planId for invoice', invoice.id);
          break;
        }

        await activateSubscriptionFromStripe({
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
        await markSubscriptionPaymentFailed({
          stripeCheckoutSessionId: session.id,
          stripeSubscriptionId: session.subscription,
          errorMessage: 'Stripe checkout async payment failed'
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await markSubscriptionPaymentFailed({
          stripeSubscriptionId: invoice.subscription,
          errorMessage: invoice.last_finalization_error?.message || 'Invoice payment failed'
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await cancelSubscriptionByStripeSubscriptionId(subscription.id);
        break;
      }

      case 'customer.subscription.updated': {
        // Keep end_date in sync when Stripe renews or modifies the subscription period
        const sub = event.data.object;
        if (sub.status === 'active' && sub.current_period_end) {
          const db = getDb();
          const existing = await db.get('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?', [sub.id]);
          if (existing) {
            const endDateIso = new Date(sub.current_period_end * 1000).toISOString();
            await db.run(`
              UPDATE subscriptions
              SET end_date = ?, status = ?, "updatedAt" = CURRENT_TIMESTAMP
              WHERE id = ?
            `, [endDateIso, SUBSCRIPTION_STATUS.ACTIVE, existing.id]);
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
  // Tables are initialized in initDatabase(); nothing to do here.

  app.post('/api/billing/webhook', handleStripeWebhook);

  app.get('/api/plans', async (req, res) => {
    try {
      const plans = await getPlans();
      res.json({ success: true, data: plans });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/billing', authMiddleware, async (req, res) => {
    try {
      if (!await resolveOwnedShopFromRequest(req, res)) return;

      res.json({
        success: true,
        data: {
          subscription: await getSubscription(req.shopId),
          usage: await getUsageStats(req.shopId)
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/billing/checkout', authMiddleware, async (req, res) => {
    try {
      const { planId, successUrl, cancelUrl, customerEmail } = req.body;
      const shop = await resolveOwnedShopFromRequest(req, res);
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

  app.get('/api/billing/subscription', authMiddleware, async (req, res) => {
    try {
      if (!await resolveOwnedShopFromRequest(req, res)) return;
      const subscription = await getSubscription(req.shopId);
      res.json({ success: true, data: subscription });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/billing/usage', authMiddleware, async (req, res) => {
    try {
      if (!await resolveOwnedShopFromRequest(req, res)) return;
      res.json({ success: true, data: await getUsageStats(req.shopId) });
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
