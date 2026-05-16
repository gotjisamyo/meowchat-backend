const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');
const { generateToken, authMiddleware } = require('../auth');
const { sendWelcomeEmail } = require('../utils/email');

const router = express.Router();

// Register: 10 attempts per 15 minutes per IP
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts', message: 'ลองใหม่อีกครั้งใน 15 นาที' },
});

// Login lockout constants — per email in DB (works across Railway instances)
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

const VALID_PLANS = ['starter', 'pro', 'business'];

router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, name, shopName, plan, billing_period, promo_code } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'กรุณากรอกข้อมูลให้ครบถ้วน'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Invalid email',
        message: 'รูปแบบอีเมลไม่ถูกต้อง'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'Password too short',
        message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร'
      });
    }

    const db = getDb();
    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(400).json({
        error: 'Email already exists',
        message: 'อีเมลนี้ถูกใช้งานแล้ว'
      });
    }

    // Sanitize optional plan/billing fields
    const pendingPlan = VALID_PLANS.includes(plan?.toLowerCase()) ? plan.toLowerCase() : null;
    const pendingBilling = billing_period === 'annual' ? 'annual' : 'monthly';
    const safeShopName = shopName ? shopName.replace(/<[^>]*>/g, '').trim().slice(0, 100) : null;

    const safePromo = promo_code ? promo_code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) : null;

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.run(
      `INSERT INTO users (email, password_hash, name, company, pending_plan, pending_billing, role, promo_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [email, passwordHash, name, safeShopName, pendingPlan, pendingBilling, 'user', safePromo]
    );

    if (safePromo) {
      db.run('UPDATE promo_codes SET signups = signups + 1 WHERE code = ?', [safePromo])
        .catch(e => console.error('[promo] signup count:', e.message));
    }

    const token = generateToken(result.lastInsertRowid, 'user');

    sendWelcomeEmail({ to: email, name }).catch(e => console.error('[email] welcome:', e.message));

    res.status(201).json({
      message: 'สมัครสมาชิกสำเร็จ',
      token,
      user: {
        id: result.lastInsertRowid,
        email,
        name,
        role: 'user'
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      error: 'Server error',
      message: 'เกิดข้อผิดพลาด กรุณาลองใหม่'
    });
  }
});

router.post('/login', registerLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Missing credentials',
        message: 'กรุณากรอกอีเมลและรหัสผ่าน'
      });
    }

    const db = getDb();
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      // Don't reveal whether email exists
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
      });
    }

    // Check if account is locked
    if (user.login_locked_until && new Date(user.login_locked_until) > new Date()) {
      const retryAfterMs = new Date(user.login_locked_until) - Date.now();
      const retryMinutes = Math.ceil(retryAfterMs / 60000);
      return res.status(429).json({
        error: 'Account locked',
        message: `บัญชีถูกล็อกชั่วคราว กรุณาลองใหม่ใน ${retryMinutes} นาที`
      });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      // Increment failed attempts
      const attempts = (user.failed_login_attempts || 0) + 1;
      if (attempts >= LOGIN_MAX_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOGIN_LOCK_DURATION_MS).toISOString();
        await db.run(
          'UPDATE users SET failed_login_attempts = ?, login_locked_until = ? WHERE id = ?',
          [attempts, lockedUntil, user.id]
        );
        return res.status(429).json({
          error: 'Account locked',
          message: 'ป้อนรหัสผ่านผิดหลายครั้ง บัญชีถูกล็อก 15 นาที'
        });
      }
      await db.run(
        'UPDATE users SET failed_login_attempts = ? WHERE id = ?',
        [attempts, user.id]
      );
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
      });
    }

    // Success — reset lockout counters
    await db.run(
      'UPDATE users SET failed_login_attempts = 0, login_locked_until = NULL WHERE id = ?',
      [user.id]
    );

    const token = generateToken(user.id, user.role || 'user');

    res.json({
      message: 'เข้าสู่ระบบสำเร็จ',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role || 'user'
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Server error',
      message: 'เกิดข้อผิดพลาด กรุณาลองใหม่'
    });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const user = await db.get('SELECT id, email, name, phone, company, role, created_at, pending_plan, pending_billing FROM users WHERE id = ?', [req.userId]);

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'ไม่พบผู้ใช้'
      });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      error: 'Server error',
      message: 'เกิดข้อผิดพลาด'
    });
  }
});

router.put('/me', authMiddleware, async (req, res) => {
  try {
    const { name, phone, company } = req.body;
    const db = getDb();

    const safeName = name ? name.replace(/<[^>]*>/g, '').trim() : null;
    const safePhone = phone ? phone.replace(/<[^>]*>/g, '').trim() : null;
    const safeCompany = company ? company.replace(/<[^>]*>/g, '').trim() : null;

    await db.run(
      'UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone), company = COALESCE(?, company) WHERE id = ?',
      [safeName, safePhone, safeCompany, req.userId]
    );

    const user = await db.get('SELECT id, email, name, phone, company, role, created_at FROM users WHERE id = ?', [req.userId]);

    res.json({ message: 'อัปเดตโปรไฟล์สำเร็จ', user });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

router.get('/me/notifications', authMiddleware, async (req, res) => {
  try {
    const db = getDb();
    const user = await db.get('SELECT notification_settings FROM users WHERE id = ?', [req.userId]);
    const defaults = { email: true, line: true, weekly: true };
    if (!user?.notification_settings) return res.json(defaults);
    try {
      res.json({ ...defaults, ...JSON.parse(user.notification_settings) });
    } catch {
      res.json(defaults);
    }
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

router.post('/me/notifications', authMiddleware, async (req, res) => {
  try {
    const { email, line, weekly } = req.body;
    const db = getDb();

    const settings = JSON.stringify({
      email: email === true,
      line: line === true,
      weekly: weekly === true
    });

    await db.run(
      'UPDATE users SET notification_settings = ? WHERE id = ?',
      [settings, req.userId]
    );

    res.json({ message: 'บันทึก notification settings สำเร็จ', settings: JSON.parse(settings) });
  } catch (error) {
    console.error('Save notifications error:', error);
    res.status(500).json({ error: 'Server error', message: 'เกิดข้อผิดพลาด' });
  }
});

router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { name, password, currentPassword, newPassword } = req.body;
    const db = getDb();

    const safeName = name ? name.replace(/<[^>]*>/g, '').trim() : null;

    // Handle password change with verification (currentPassword + newPassword)
    const targetPassword = newPassword || password;
    if (targetPassword) {
      if (targetPassword.length < 8) {
        return res.status(400).json({ error: 'Password too short', message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' });
      }
      // Require currentPassword when changing via newPassword (security)
      if (newPassword) {
        if (!currentPassword) {
          return res.status(400).json({ error: 'Current password required', message: 'กรุณาระบุรหัสผ่านปัจจุบัน' });
        }
        const userRow = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.userId]);
        const valid = await bcrypt.compare(currentPassword, userRow?.password_hash || '');
        if (!valid) {
          return res.status(400).json({ error: 'Wrong password', message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
        }
      }
      const passwordHash = await bcrypt.hash(targetPassword, 10);
      await db.run('UPDATE users SET name = COALESCE(?, name), password_hash = ? WHERE id = ?', [safeName, passwordHash, req.userId]);
    } else if (safeName) {
      await db.run('UPDATE users SET name = ? WHERE id = ?', [safeName, req.userId]);
    }

    const user = await db.get('SELECT id, email, name, role, created_at FROM users WHERE id = ?', [req.userId]);

    res.json({
      message: 'อัปเดตโปรไฟล์สำเร็จ',
      user
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      error: 'Server error',
      message: 'เกิดข้อผิดพลาด'
    });
  }
});

module.exports = router;
