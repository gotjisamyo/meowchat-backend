const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireOwnedShop } = require('../middleware/shopAccess');

// ── Gemini Vision: analyse a payment slip image ───────────────────────────────
// Returns { amount: number|null, transactionId: string|null, status: 'verified'|'unverifiable' }
async function analyzeSlipWithAI(base64Image, mimeType = 'image/jpeg') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[slip-ai] GEMINI_API_KEY not set — skipping AI verification');
    return { amount: null, transactionId: null, status: 'unverifiable' };
  }

  const prompt = `You are a payment slip OCR assistant. Examine this Thai PromptPay / bank transfer slip image.
Extract the following information and respond ONLY with a JSON object (no markdown, no extra text):
{
  "amount": <transfer amount as a number, e.g. 199. null if not found>,
  "transactionId": "<transaction ID or reference number as a string. null if not found>",
  "transferDate": "<date in YYYY-MM-DD format. null if not found>",
  "status": "<'verified' if you can clearly read a transfer amount, else 'unverifiable'>"
}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: base64Image } }
            ]
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 256,
          }
        })
      }
    );

    if (!response.ok) {
      const body = await response.text();
      console.error('[slip-ai] Gemini API error:', response.status, body.slice(0, 200));
      return { amount: null, transactionId: null, status: 'unverifiable' };
    }

    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      amount: parsed.amount != null ? Number(parsed.amount) : null,
      transactionId: parsed.transactionId || null,
      transferDate: parsed.transferDate || null,
      status: parsed.status === 'verified' ? 'verified' : 'unverifiable',
    };
  } catch (err) {
    console.error('[slip-ai] error:', err.message);
    return { amount: null, transactionId: null, status: 'unverifiable' };
  }
}

// ── Auto-approve helper ───────────────────────────────────────────────────────
async function autoApproveCredit(db, paymentNotificationId) {
  await db.run(
    `UPDATE payment_notifications SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [paymentNotificationId]
  );
  await db.run(
    `UPDATE merchant_credits SET status = 'approved' WHERE payment_notification_id = ?`,
    [paymentNotificationId]
  );
  console.log(`[slip-ai] auto-approved credit for payment_notification_id=${paymentNotificationId}`);
}

// GET /api/credits/packs — list available credit packs
router.get('/packs', async (_req, res) => {
  try {
    const db = getDb();
    const packs = await db.all(`SELECT * FROM credit_packs WHERE is_active = 1 ORDER BY price ASC`);
    res.json({ packs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/credits/balance/:shopId — merchant credit balance
router.get('/balance/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;

    const credits = await db.all(
      `SELECT id, messages_added, messages_used, created_at, expires_at, status
       FROM merchant_credits
       WHERE shop_id = ? AND status = 'approved'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at ASC`,
      [shopId]
    );

    const totalAvailable = credits.reduce((sum, c) =>
      sum + Math.max(0, c.messages_added - c.messages_used), 0
    );

    res.json({ credits, totalAvailable });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/credits/purchase/:shopId — request to buy a credit pack (creates pending record)
router.post('/purchase/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;
    const { packId } = req.body;
    if (!packId) return res.status(400).json({ error: 'packId required' });

    const pack = await db.get(`SELECT * FROM credit_packs WHERE id = ? AND is_active = 1`, [packId]);
    if (!pack) return res.status(404).json({ error: 'pack not found' });

    // Generate unique reference number for this purchase
    const refNumber = `CR-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const paymentResult = await db.run(
      `INSERT INTO payment_notifications
         (shop_id, payer_name, amount, transfer_date, bank_name, account_name, account_number, ref_number, status)
       VALUES (?, ?, ?, CURRENT_DATE, 'กสิกรไทย (Kasikornbank)', 'นายกฤษฐาพงศ์ จิรกุลวิชยวงษ์', '089-3-66849-7', ?, 'pending')
       RETURNING id`,
      [shopId, `Credit Pack ${pack.name}`, pack.price, refNumber]
    );
    const paymentId = paymentResult.lastInsertRowid;

    await db.run(
      `INSERT INTO merchant_credits (shop_id, messages_added, pack_id, payment_notification_id, status, expires_at)
       VALUES (?, ?, ?, ?, 'pending', NOW() + INTERVAL '90 days')`,
      [shopId, pack.messages, pack.id, paymentId]
    );

    res.json({
      ok: true,
      paymentId,
      refNumber,
      pack: { name: pack.name, messages: pack.messages, price: pack.price },
      bankInfo: {
        bankName: 'กสิกรไทย (Kasikornbank)',
        accountName: 'นายกฤษฐาพงศ์ จิรกุลวิชยวงษ์',
        accountNumber: '089-3-66849-7',
      },
      instructions: `โอนเงิน ฿${pack.price} แล้วอัปโหลดสลิปในขั้นตอนถัดไป ระบบ AI จะตรวจสอบและเปิดเครดิตให้อัตโนมัติ`,
    });
  } catch (err) {
    console.error('[credits/purchase] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/credits/submit-slip/:shopId — merchant submits payment slip; AI auto-approves if amount matches
router.post('/submit-slip/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;
    const { paymentId, refNumber, proofBase64, proofFileName, proofContentType } = req.body;

    if (!paymentId && !refNumber) {
      return res.status(400).json({ error: 'paymentId or refNumber required' });
    }
    if (!proofBase64) {
      return res.status(400).json({ error: 'proofBase64 is required' });
    }

    // Find the payment notification
    let notification = null;
    if (paymentId) {
      notification = await db.get(
        `SELECT * FROM payment_notifications WHERE id = ? AND shop_id = ?`,
        [paymentId, shopId]
      );
    } else if (refNumber) {
      notification = await db.get(
        `SELECT * FROM payment_notifications WHERE ref_number = ? AND shop_id = ?`,
        [refNumber, shopId]
      );
    }

    if (!notification) {
      return res.status(404).json({ error: 'payment record not found' });
    }
    if (notification.status === 'approved') {
      return res.json({ ok: true, autoApproved: true, message: 'เครดิตนี้ได้รับการ approve แล้ว' });
    }

    // Store the slip first (regardless of AI result)
    await db.run(
      `UPDATE payment_notifications
       SET proof_base64 = ?, proof_file_name = ?, proof_content_type = ?,
           status = 'pending', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [proofBase64 || null, proofFileName || null, proofContentType || null, notification.id]
    );

    // Run AI slip analysis
    const mimeType = proofContentType || 'image/jpeg';
    // Strip data URL prefix if present
    const imageData = proofBase64.replace(/^data:[^;]+;base64,/, '');
    const aiResult = await analyzeSlipWithAI(imageData, mimeType);

    console.log(`[slip-ai] shopId=${shopId} paymentId=${notification.id} amount=${notification.amount} ai=${JSON.stringify(aiResult)}`);

    // Check: AI verified AND amount matches (allow ±1 baht tolerance for rounding)
    const expectedAmount = Number(notification.amount);
    const detectedAmount = aiResult.amount;
    const amountMatch = detectedAmount != null && Math.abs(detectedAmount - expectedAmount) <= 1;

    if (aiResult.status === 'verified' && amountMatch) {
      // ✅ Auto-approve
      await autoApproveCredit(db, notification.id);

      // Store the AI-detected transaction ID for audit trail
      if (aiResult.transactionId) {
        await db.run(
          `UPDATE payment_notifications SET ref_number = COALESCE(ref_number, ?) WHERE id = ?`,
          [aiResult.transactionId, notification.id]
        );
      }

      return res.json({
        ok: true,
        autoApproved: true,
        detectedAmount,
        message: `✅ ระบบตรวจสอบสลิปสำเร็จ! เครดิต ${notification.amount} บาท ถูกเปิดใช้งานแล้ว`,
      });
    }

    // ❌ AI could not verify — keep as pending for Admin
    const reason = aiResult.status === 'unverifiable'
      ? 'ไม่สามารถอ่านสลิปได้'
      : `ยอดในสลิป (฿${detectedAmount}) ไม่ตรงกับยอดที่ต้องชำระ (฿${expectedAmount})`;

    return res.json({
      ok: true,
      autoApproved: false,
      detectedAmount,
      message: `บันทึกสลิปแล้ว (${reason}) ทีมงานจะตรวจสอบและเปิดเครดิตภายใน 24 ชั่วโมง`,
    });
  } catch (err) {
    console.error('[credits/submit-slip] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/credits/pending/:shopId — list pending/unapproved credit purchases
router.get('/pending/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;

    const pending = await db.all(
      `SELECT mc.id, mc.messages_added, mc.status, mc.created_at,
              pn.amount, pn.ref_number, pn.proof_file_name, pn.status as payment_status,
              cp.name as pack_name
       FROM merchant_credits mc
       LEFT JOIN payment_notifications pn ON pn.id = mc.payment_notification_id
       LEFT JOIN credit_packs cp ON cp.id = mc.pack_id
       WHERE mc.shop_id = ? AND mc.status != 'approved'
       ORDER BY mc.created_at DESC`,
      [shopId]
    );

    res.json({ pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/credits/usage/:shopId — current month usage including credits
router.get('/usage/:shopId', requireOwnedShop, async (req, res) => {
  try {
    const db = getDb();
    const { shopId } = req.params;

    const sub = await db.get(
      `SELECT p.max_chats FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.shop_id = ? AND s.status = 'active' ORDER BY s.created_at DESC LIMIT 1`,
      [shopId]
    );

    const usageRow = await db.get(
      `SELECT COUNT(*) as cnt FROM conversation_messages cm
       JOIN conversations cv ON cv.id = cm.conversation_id
       WHERE cv.shop_id = ? AND cm.role = 'user'
         AND date_trunc('month', cm.created_at) = date_trunc('month', NOW())`,
      [shopId]
    );
    const used = Number(usageRow?.cnt || 0);
    const planLimit = sub?.max_chats ?? 300;

    const creditsRow = await db.get(
      `SELECT COALESCE(SUM(messages_added - messages_used), 0) as extra
       FROM merchant_credits
       WHERE shop_id = ? AND status = 'approved'
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [shopId]
    );
    const extraCredits = Number(creditsRow?.extra || 0);
    const totalLimit = planLimit === -1 ? -1 : planLimit + extraCredits;

    res.json({ used, planLimit, extraCredits, totalLimit, shopId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
