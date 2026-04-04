const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');
const { generateToken, authMiddleware } = require('../auth');

const router = express.Router();

// Max 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts', message: 'ลองใหม่อีกครั้งใน 15 นาที' },
});

router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;

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

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.run(
      'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?) RETURNING id',
      [email, passwordHash, name, 'user']
    );

    const token = generateToken(result.lastInsertRowid, 'user');

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

router.post('/login', authLimiter, async (req, res) => {
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
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
      });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
      });
    }

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
    const user = await db.get('SELECT id, email, name, role, created_at FROM users WHERE id = ?', [req.userId]);

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

router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { name, password } = req.body;
    const db = getDb();

    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      await db.run('UPDATE users SET name = ?, password_hash = ? WHERE id = ?', [name, passwordHash, req.userId]);
    } else if (name) {
      await db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.userId]);
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
