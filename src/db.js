const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway PostgreSQL always requires SSL; rejectUnauthorized:false accepts self-signed certs
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Convert ? placeholders to $1, $2, ...
function toPos(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const db = {
  async get(sql, params = []) {
    const { rows } = await pool.query(toPos(sql), params);
    return rows[0] || null;
  },
  async all(sql, params = []) {
    const { rows } = await pool.query(toPos(sql), params);
    return rows;
  },
  // For INSERT with RETURNING id; also handles UPDATE/DELETE (rowCount only)
  async run(sql, params = []) {
    const { rows, rowCount } = await pool.query(toPos(sql), params);
    return { changes: rowCount, lastInsertRowid: rows[0]?.id ?? null };
  },
  async exec(sql) {
    return pool.query(sql);
  },
  // Compatibility shim: some code calls db.prepare(sql).get/all/run
  prepare(sql) {
    return {
      get: (...params) => db.get(sql, params.flat()),
      all: (...params) => db.all(sql, params.flat()),
      run: (...params) => db.run(sql, params.flat()),
    };
  },
};

function getDb() {
  return db;
}

async function initDatabase() {
  // Create orders table (legacy schema — new orders use shop_id/total_amount added below)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      "lineId" TEXT,
      product TEXT,
      quantity INTEGER DEFAULT 1,
      price REAL DEFAULT 0,
      details TEXT,
      status TEXT DEFAULT 'pending',
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add new columns to orders for shop-based orders (safe: IF NOT EXISTS)
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shop_id TEXT`);
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id TEXT`);
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT`);
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS items TEXT`);
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount REAL DEFAULT 0`);
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT`);
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address TEXT`);
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS note TEXT`);
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
  await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);

  // Create users table (email/password auth)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'`);

  // Create shops table (multi-tenant)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      line_channel_id TEXT DEFAULT '',
      line_channel_secret TEXT DEFAULT '',
      line_access_token TEXT DEFAULT '',
      plan TEXT DEFAULT 'free',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Create products table (linked to shop)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      "imageUrl" TEXT,
      category TEXT,
      status TEXT DEFAULT 'active',
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Marketing Campaigns
  await db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'auto',
      trigger TEXT DEFAULT 'signup',
      steps TEXT,
      status TEXT DEFAULT 'active',
      shop_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS shop_id TEXT`);

  // Marketing Automations
  await db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_automations (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      template_id INTEGER,
      channel TEXT DEFAULT 'line',
      status TEXT DEFAULT 'active',
      shop_id TEXT,
      next_send TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`ALTER TABLE marketing_automations ADD COLUMN IF NOT EXISTS shop_id TEXT`);

  // Marketing Scheduled Messages
  await db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_scheduled (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      send_at TIMESTAMP NOT NULL,
      channel TEXT DEFAULT 'line',
      status TEXT DEFAULT 'pending',
      shop_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`ALTER TABLE marketing_scheduled ADD COLUMN IF NOT EXISTS shop_id TEXT`);

  // Customers table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      line_user_id TEXT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      note TEXT,
      customer_group TEXT DEFAULT 'regular',
      status TEXT DEFAULT 'active',
      total_orders INTEGER DEFAULT 0,
      total_spent REAL DEFAULT 0,
      first_order_at TIMESTAMP,
      last_order_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Plans table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      max_chats INTEGER NOT NULL,
      max_agents INTEGER NOT NULL,
      features TEXT,
      is_active INTEGER DEFAULT 1,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Subscriptions table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      shop_id TEXT NOT NULL,
      plan_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      end_date TIMESTAMP,
      payment_method TEXT,
      payment_status TEXT DEFAULT 'pending',
      stripe_checkout_session_id TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_payment_intent_id TEXT,
      stripe_price_id TEXT,
      checkout_url TEXT,
      last_payment_error TEXT,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    )
  `);

  // Team members table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      shop_id TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Payment notifications table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS payment_notifications (
      id SERIAL PRIMARY KEY,
      shop_id TEXT,
      payer_name TEXT NOT NULL,
      amount REAL NOT NULL,
      transfer_date TEXT NOT NULL,
      proof_file_name TEXT,
      proof_content_type TEXT,
      proof_base64 TEXT,
      bank_name TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_number TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Inventory tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 0,
      min_stock_level INTEGER DEFAULT 10,
      location TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      inventory_id TEXT,
      product_id INTEGER,
      shop_id TEXT,
      type TEXT,
      quantity INTEGER,
      reference TEXT,
      notes TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS stock_alerts (
      id TEXT PRIMARY KEY,
      shop_id TEXT,
      product_id INTEGER,
      type TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Projects tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      shop_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'todo',
      project_id INTEGER NOT NULL,
      due_date TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Handoffs table — human handoff requests
  await db.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      customer_id TEXT,
      line_user_id TEXT,
      customer_name TEXT,
      message TEXT,
      status TEXT DEFAULT 'pending',
      resolved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_handoffs_shop_id ON handoffs(shop_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status)`);

  // Usage tracking table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS usage_tracking (
      id SERIAL PRIMARY KEY,
      shop_id TEXT NOT NULL,
      chats_count INTEGER DEFAULT 0,
      agents_count INTEGER DEFAULT 0,
      period_start TIMESTAMP,
      period_end TIMESTAMP,
      "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for performance
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shops_user_id ON shops(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_payment_notifications_shop_id ON payment_notifications(shop_id);
  `);

  // Create unique indexes for subscriptions (may fail silently if already exist)
  try {
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_checkout_session ON subscriptions(stripe_checkout_session_id)`);
  } catch (e) { /* ignore if already exists */ }
  try {
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription ON subscriptions(stripe_subscription_id)`);
  } catch (e) { /* ignore if already exists */ }

  // Seed plans data (use OVERRIDING SYSTEM VALUE to set explicit ids for SERIAL column)
  await db.exec(`
    INSERT INTO plans (id, name, price, max_chats, max_agents, features, is_active)
    OVERRIDING SYSTEM VALUE
    VALUES
      (1, 'Free', 0, 300, 1, '["ใช้งานได้ 1 Bot","300 ข้อความ/เดือน","รองรับ LINE Bot","สถิติพื้นฐาน"]', 1),
      (2, 'Starter', 390, 3000, 1, '["ใช้งานได้ 1 Bot","3,000 ข้อความ/เดือน","รองรับ LINE Bot","สถิติพื้นฐาน","สนับสนุนทาง Email"]', 1),
      (3, 'Pro', 590, 15000, 3, '["ใช้งานได้ 3 Bots","15,000 ข้อความ/เดือน","รองรับ LINE Bot","สถิติขั้นสูง","AI Auto Reply","สนับสนุนทาง Email & Chat"]', 1),
      (4, 'Enterprise', 3900, -1, -1, '["ใช้งานได้ไม่จำกัด Bots","ข้อความไม่จำกัด","รองรับ LINE Bot & Multi-channel","สถิติขั้นสูง & Analytics","AI Auto Reply","API Access","ลำดับชั้นผู้ใช้งาน","สนับสนุน 24/7"]', 1)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      price = excluded.price,
      max_chats = excluded.max_chats,
      max_agents = excluded.max_agents,
      features = excluded.features,
      is_active = excluded.is_active
  `);

  // Auto-promote ADMIN_EMAIL to admin role if set
  if (process.env.ADMIN_EMAIL) {
    await db.run(
      `UPDATE users SET role = 'admin' WHERE email = ?`,
      [process.env.ADMIN_EMAIL.toLowerCase()]
    );
  }

  console.log('✅ Database initialized successfully');
}

async function saveOrder(order) {
  const result = await db.run(`
    INSERT INTO orders ("lineId", product, quantity, price, details, status)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id
  `, [
    order.lineId,
    order.product,
    order.quantity || 1,
    order.price || 0,
    order.details || '',
    order.status || 'pending'
  ]);

  console.log(`📦 Order saved: ID ${result.lastInsertRowid}`);
  return result.lastInsertRowid;
}

async function getOrders(options = {}) {
  let query = 'SELECT * FROM orders';
  const params = [];

  if (options.lineId) {
    query += ' WHERE "lineId" = ?';
    params.push(options.lineId);
  }

  if (options.status) {
    query += params.length ? ' AND status = ?' : ' WHERE status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY "createdAt" DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  return db.all(query, params);
}

async function updateOrderStatus(orderId, status) {
  return db.run(`
    UPDATE orders
    SET status = ?, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [status, orderId]);
}

async function saveUser(user) {
  return db.run(`
    INSERT INTO users ("lineId", "displayName", "pictureUrl", "updatedAt")
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT ("lineId") DO UPDATE SET "displayName" = EXCLUDED."displayName", "pictureUrl" = EXCLUDED."pictureUrl", "updatedAt" = CURRENT_TIMESTAMP
  `, [user.lineId, user.displayName, user.pictureUrl]);
}

async function getUser(lineId) {
  return db.get('SELECT * FROM users WHERE "lineId" = ?', [lineId]);
}

// ========== NEW AUTH FUNCTIONS ==========

// Create new user (email/password)
async function createUser(email, passwordHash, name) {
  const result = await db.run(`
    INSERT INTO users (email, password_hash, name)
    VALUES (?, ?, ?) RETURNING id
  `, [email, passwordHash, name || null]);
  return result.lastInsertRowid;
}

// Find user by email
async function findUserByEmail(email) {
  return db.get('SELECT * FROM users WHERE email = ?', [email]);
}

// Find user by ID
async function findUserById(id) {
  return db.get('SELECT * FROM users WHERE id = ?', [id]);
}

// Create shop
async function createShop(shop) {
  const result = await db.run(`
    INSERT INTO shops (user_id, name, line_channel_id, line_secret, line_token, plan)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id
  `, [
    shop.user_id,
    shop.name,
    shop.line_channel_id || null,
    shop.line_secret || null,
    shop.line_token || null,
    shop.plan || 'free'
  ]);
  return result.lastInsertRowid;
}

// Get shops by user ID
async function getShopsByUserId(userId) {
  return db.all('SELECT * FROM shops WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

// Get shop by ID
async function getShopById(shopId) {
  return db.get('SELECT * FROM shops WHERE id = ?', [shopId]);
}

// Update shop
async function updateShop(shopId, updates) {
  const fields = [];
  const values = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.line_channel_id !== undefined) {
    fields.push('line_channel_id = ?');
    values.push(updates.line_channel_id);
  }
  if (updates.line_secret !== undefined) {
    fields.push('line_secret = ?');
    values.push(updates.line_secret);
  }
  if (updates.line_token !== undefined) {
    fields.push('line_token = ?');
    values.push(updates.line_token);
  }
  if (updates.plan !== undefined) {
    fields.push('plan = ?');
    values.push(updates.plan);
  }

  if (fields.length === 0) return null;

  values.push(shopId);
  return db.run(`UPDATE shops SET ${fields.join(', ')} WHERE id = ?`, values);
}

// Delete shop
async function deleteShop(shopId) {
  return db.run('DELETE FROM shops WHERE id = ?', [shopId]);
}

// ========== END AUTH FUNCTIONS ==========

async function getProducts(options = {}) {
  let query = 'SELECT * FROM products WHERE status = ?';
  const params = ['active'];

  if (options.shopId) {
    query = 'SELECT * FROM products WHERE shop_id = ? AND status = ?';
    params.unshift(options.shopId);
  }

  if (options.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  return db.all(query, params);
}

async function getDashboardStats(shopId) {
  const [
    { count: totalOrders },
    { count: pendingOrders },
    { count: completedOrders },
    { total: totalRevenue },
    { count: totalProducts },
    { count: totalCustomers }
  ] = await Promise.all([
    db.get('SELECT COUNT(*) as count FROM orders WHERE shop_id = ?', [shopId]),
    db.get("SELECT COUNT(*) as count FROM orders WHERE shop_id = ? AND status = 'pending'", [shopId]),
    db.get("SELECT COUNT(*) as count FROM orders WHERE shop_id = ? AND status = 'completed'", [shopId]),
    db.get('SELECT COALESCE(SUM(COALESCE(total_amount, price, 0)), 0) as total FROM orders WHERE shop_id = ? AND status = ?', [shopId, 'completed']),
    db.get('SELECT COUNT(*) as count FROM products WHERE shop_id = ?', [shopId]),
    db.get("SELECT COUNT(*) as count FROM customers WHERE shop_id = ? AND status != ?", [shopId, 'deleted']),
  ]);

  return {
    shopId,
    totalOrders: Number(totalOrders) || 0,
    pendingOrders: Number(pendingOrders) || 0,
    completedOrders: Number(completedOrders) || 0,
    totalRevenue: Number(totalRevenue) || 0,
    totalProducts: Number(totalProducts) || 0,
    totalCustomers: Number(totalCustomers) || 0
  };
}

module.exports = {
  initDatabase,
  getDb,
  saveOrder,
  getOrders,
  updateOrderStatus,
  saveUser,
  getUser,
  getProducts,
  getDashboardStats,
  // Auth exports
  createUser,
  findUserByEmail,
  findUserById,
  createShop,
  getShopsByUserId,
  getShopById,
  updateShop,
  deleteShop
};

