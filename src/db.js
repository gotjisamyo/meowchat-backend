const Database = require('better-sqlite3');
const path = require('path');

let db = null;

function getDb() {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'database.sqlite');
    db = new Database(dbPath);
  }
  return db;
}

function initDatabase() {
  const db = getDb();
  
  // Create orders table
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lineId TEXT NOT NULL,
      product TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      price REAL DEFAULT 0,
      details TEXT,
      status TEXT DEFAULT 'pending',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create users table (email/password auth)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const userColumns = db.prepare(`PRAGMA table_info(users)`).all();
  const hasRoleColumn = userColumns.some((column) => column.name === 'role');
  if (!hasRoleColumn) {
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`);
  }

  // Create shops table (multi-tenant)
  db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      line_channel_id TEXT DEFAULT '',
      line_channel_secret TEXT DEFAULT '',
      line_access_token TEXT DEFAULT '',
      plan TEXT DEFAULT 'free',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Create products table (linked to shop)
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      imageUrl TEXT,
      category TEXT,
      status TEXT DEFAULT 'active',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Marketing Campaigns
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'auto',
      trigger TEXT DEFAULT 'signup',
      steps TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Marketing Automations
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_automations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      template_id INTEGER,
      channel TEXT DEFAULT 'line',
      status TEXT DEFAULT 'active',
      next_send DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Marketing Scheduled Messages
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_scheduled (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      send_at DATETIME NOT NULL,
      channel TEXT DEFAULT 'line',
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shops_user_id ON shops(user_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);

  console.log('✅ Database initialized successfully');
}

function saveOrder(order) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO orders (lineId, product, quantity, price, details, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  const result = stmt.run(
    order.lineId,
    order.product,
    order.quantity || 1,
    order.price || 0,
    order.details || '',
    order.status || 'pending'
  );

  console.log(`📦 Order saved: ID ${result.lastInsertRowid}`);
  return result.lastInsertRowid;
}

function getOrders(options = {}) {
  const db = getDb();
  let query = 'SELECT * FROM orders';
  const params = [];

  if (options.lineId) {
    query += ' WHERE lineId = ?';
    params.push(options.lineId);
  }

  if (options.status) {
    query += params.length ? ' AND status = ?' : ' WHERE status = ?';
    params.push(options.status);
  }

  query += ' ORDER BY createdAt DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

function updateOrderStatus(orderId, status) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE orders 
    SET status = ?, updatedAt = CURRENT_TIMESTAMP 
    WHERE id = ?
  `);
  return stmt.run(status, orderId);
}

function saveUser(user) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO users (lineId, displayName, pictureUrl, updatedAt)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `);
  return stmt.run(user.lineId, user.displayName, user.pictureUrl);
}

function getUser(lineId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE lineId = ?');
  return stmt.get(lineId);
}

// ========== NEW AUTH FUNCTIONS ==========

// Create new user (email/password)
function createUser(email, passwordHash, name) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO users (email, password_hash, name)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(email, passwordHash, name || null);
  return result.lastInsertRowid;
}

// Find user by email
function findUserByEmail(email) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
  return stmt.get(email);
}

// Find user by ID
function findUserById(id) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(id);
}

// Create shop
function createShop(shop) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO shops (user_id, name, line_channel_id, line_secret, line_token, plan)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    shop.user_id,
    shop.name,
    shop.line_channel_id || null,
    shop.line_secret || null,
    shop.line_token || null,
    shop.plan || 'free'
  );
  return result.lastInsertRowid;
}

// Get shops by user ID
function getShopsByUserId(userId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM shops WHERE user_id = ? ORDER BY created_at DESC');
  return stmt.all(userId);
}

// Get shop by ID
function getShopById(shopId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM shops WHERE id = ?');
  return stmt.get(shopId);
}

// Update shop
function updateShop(shopId, updates) {
  const db = getDb();
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
  const stmt = db.prepare(`UPDATE shops SET ${fields.join(', ')} WHERE id = ?`);
  return stmt.run(...values);
}

// Delete shop
function deleteShop(shopId) {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM shops WHERE id = ?');
  return stmt.run(shopId);
}

// ========== END AUTH FUNCTIONS ==========

function getProducts(options = {}) {
  const db = getDb();
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

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

function getDashboardStats(shopId) {
  const db = getDb();

  const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders WHERE shop_id = ?').get(shopId).count;
  const pendingOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE shop_id = ? AND status = 'pending'").get(shopId).count;
  const completedOrders = db.prepare("SELECT COUNT(*) as count FROM orders WHERE shop_id = ? AND status = 'completed'").get(shopId).count;
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE shop_id = ? AND status = ?').get(shopId, 'completed').total || 0;
  const totalProducts = db.prepare('SELECT COUNT(*) as count FROM products WHERE shop_id = ?').get(shopId).count;
  const totalCustomers = db.prepare('SELECT COUNT(*) as count FROM customers WHERE shop_id = ? AND status != ?').get(shopId, 'deleted').count;

  return {
    shopId,
    totalOrders,
    pendingOrders,
    completedOrders,
    totalRevenue,
    totalProducts,
    totalCustomers
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
