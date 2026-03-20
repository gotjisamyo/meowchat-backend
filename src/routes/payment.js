const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

const BANK_INFO = {
  bankName: 'กสิกรไทย (Kasikornbank)',
  accountName: 'นายกฤษฐาพงศ์ จิรกุลวิชยวงษ์',
  accountNumber: '089-3-66849-7'
};

const MAX_PROOF_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_PROOF_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const MIME_SIGNATURES = {
  'image/jpeg': [
    { offset: 0, bytes: [0xff, 0xd8, 0xff] }
  ],
  'image/png': [
    { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }
  ]
};

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initPaymentTable() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  ensureColumn(db, 'payment_notifications', 'shop_id', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payment_notifications_shop_id ON payment_notifications(shop_id)`);
}

function normalizeBase64(input) {
  const value = String(input || '').trim();
  if (!value) {
    return { contentTypeFromDataUrl: null, base64Data: '' };
  }

  const dataUrlMatch = value.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    return {
      contentTypeFromDataUrl: String(dataUrlMatch[1] || '').toLowerCase(),
      base64Data: String(dataUrlMatch[2] || '').replace(/\s+/g, '')
    };
  }

  return {
    contentTypeFromDataUrl: null,
    base64Data: value.replace(/\s+/g, '')
  };
}

function detectMimeTypeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null;
  }

  for (const [mimeType, signatures] of Object.entries(MIME_SIGNATURES)) {
    const matched = signatures.some(({ offset, bytes }) => {
      if (buffer.length < offset + bytes.length) {
        return false;
      }
      return bytes.every((byte, index) => buffer[offset + index] === byte);
    });

    if (matched) {
      return mimeType;
    }
  }

  return null;
}

function validateProofImage(proofImage) {
  if (!proofImage?.base64 || !proofImage?.fileName) {
    return { error: 'proofImage is required' };
  }

  const { contentTypeFromDataUrl, base64Data } = normalizeBase64(proofImage.base64);
  if (!base64Data) {
    return { error: 'proofImage.base64 is required' };
  }

  let buffer;
  try {
    buffer = Buffer.from(base64Data, 'base64');
  } catch (error) {
    return { error: 'proofImage.base64 is invalid' };
  }

  if (!buffer.length || buffer.toString('base64') !== base64Data) {
    return { error: 'proofImage.base64 is invalid' };
  }

  if (buffer.length > MAX_PROOF_IMAGE_BYTES) {
    return { error: 'proofImage exceeds max size of 5MB' };
  }

  const clientContentType = String(proofImage.contentType || '').trim().toLowerCase();
  const declaredContentType = contentTypeFromDataUrl || clientContentType;

  if (!declaredContentType || !ALLOWED_PROOF_MIME_TYPES.has(declaredContentType)) {
    return { error: 'proofImage contentType must be image/jpeg or image/png' };
  }

  if (declaredContentType === 'image/svg+xml' || clientContentType === 'image/svg+xml') {
    return { error: 'SVG uploads are not allowed' };
  }

  const detectedContentType = detectMimeTypeFromBuffer(buffer);
  if (!detectedContentType || !ALLOWED_PROOF_MIME_TYPES.has(detectedContentType)) {
    return { error: 'proofImage content does not match an allowed image type' };
  }

  if (detectedContentType !== declaredContentType) {
    return { error: 'proofImage contentType does not match file content' };
  }

  return {
    fileName: String(proofImage.fileName || '').trim(),
    contentType: detectedContentType,
    base64: base64Data
  };
}

initPaymentTable();

router.get('/info', (req, res) => {
  res.json({
    success: true,
    data: BANK_INFO
  });
});

router.post('/notify', (req, res) => {
  try {
    const {
      shopId,
      payerName,
      amount,
      transferDate,
      proofImage,
      bankName,
      accountName,
      accountNumber
    } = req.body || {};

    if (!shopId || !String(shopId).trim()) {
      return res.status(400).json({ success: false, error: 'shopId is required' });
    }

    if (!payerName || !String(payerName).trim()) {
      return res.status(400).json({ success: false, error: 'payerName is required' });
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: 'amount must be greater than 0' });
    }

    if (!transferDate || Number.isNaN(new Date(transferDate).getTime())) {
      return res.status(400).json({ success: false, error: 'transferDate is invalid' });
    }

    const validatedProofImage = validateProofImage(proofImage);
    if (validatedProofImage.error) {
      return res.status(400).json({ success: false, error: validatedProofImage.error });
    }

    const db = getDb();
    const shop = db.prepare('SELECT id FROM shops WHERE id = ?').get(String(shopId).trim());
    if (!shop) {
      return res.status(404).json({ success: false, error: 'shopId is invalid' });
    }

    const stmt = db.prepare(`
      INSERT INTO payment_notifications (
        shop_id,
        payer_name,
        amount,
        transfer_date,
        proof_file_name,
        proof_content_type,
        proof_base64,
        bank_name,
        account_name,
        account_number,
        status,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `);

    const normalizedShopId = String(shopId).trim();
    const normalizedTransferDate = new Date(transferDate).toISOString();
    const normalizedPayerName = String(payerName).trim();

    const result = stmt.run(
      normalizedShopId,
      normalizedPayerName,
      parsedAmount,
      normalizedTransferDate,
      validatedProofImage.fileName,
      validatedProofImage.contentType,
      validatedProofImage.base64,
      String(bankName || BANK_INFO.bankName).trim(),
      String(accountName || BANK_INFO.accountName).trim(),
      String(accountNumber || BANK_INFO.accountNumber).trim()
    );

    res.status(201).json({
      success: true,
      data: {
        id: result.lastInsertRowid,
        shopId: normalizedShopId,
        payerName: normalizedPayerName,
        amount: parsedAmount,
        transferDate: normalizedTransferDate,
        status: 'pending'
      },
      message: 'บันทึกการแจ้งโอนเรียบร้อยแล้ว'
    });
  } catch (error) {
    console.error('payment notify error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
