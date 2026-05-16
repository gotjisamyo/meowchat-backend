const { Resend } = require('resend');

let resend = null;
function getResend() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const FROM = process.env.EMAIL_FROM || 'MeowChat <noreply@meowchat.store>';

async function sendEmail({ to, subject, html }) {
  const client = getResend();
  if (!client) {
    console.log(`[email] RESEND_API_KEY not set — skip email to ${to}: ${subject}`);
    return;
  }
  try {
    const { error } = await client.emails.send({ from: FROM, to, subject, html });
    if (error) console.error('[email] send error:', error);
    else console.log(`[email] sent to ${to}: ${subject}`);
  } catch (err) {
    console.error('[email] exception:', err.message);
  }
}

// ── Templates ────────────────────────────────────────────────────────────────

function emailBase(content) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:0}
.wrap{max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.head{background:linear-gradient(135deg,#16a34a,#22c55e);padding:32px 32px 24px;text-align:center}
.head h1{color:#fff;margin:0;font-size:22px;font-weight:800}
.head p{color:#dcfce7;margin:6px 0 0;font-size:14px}
.body{padding:32px}
.body p{color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px}
.btn{display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff!important;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px}
.info{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;margin:16px 0}
.info p{margin:4px 0;color:#166534;font-size:14px}
.foot{padding:16px 32px 24px;text-align:center;color:#9ca3af;font-size:12px}
</style></head><body>
<div class="wrap">
  <div class="head"><h1>🐱 MeowChat</h1><p>AI ช่วยร้านค้าไทยตอบแชทอัตโนมัติ</p></div>
  <div class="body">${content}</div>
  <div class="foot">© 2026 MeowChat · <a href="https://meowchat.store" style="color:#16a34a">meowchat.store</a></div>
</div></body></html>`;
}

async function sendWelcomeEmail({ to, name }) {
  await sendEmail({
    to,
    subject: '🐱 ยินดีต้อนรับสู่ MeowChat!',
    html: emailBase(`
      <p>สวัสดีครับคุณ <strong>${name || 'คุณ'}</strong> 👋</p>
      <p>ยินดีต้อนรับสู่ <strong>MeowChat</strong> — AI ตอบแชท LINE OA ให้ร้านคุณ 24/7 โดยไม่ต้องจ้างแอดมิน</p>
      <div class="info">
        <p>✅ ทดลองใช้ฟรี <strong>14 วัน</strong></p>
        <p>✅ ไม่ต้องใส่บัตรเครดิต</p>
        <p>✅ เชื่อม LINE OA ได้ภายใน 5 นาที</p>
      </div>
      <p>เริ่มต้นเชื่อม LINE OA และตั้งค่าบอทได้เลยครับ:</p>
      <p style="text-align:center;margin:24px 0"><a href="https://my.meowchat.store" class="btn">เริ่มตั้งค่าบอท →</a></p>
      <p style="font-size:13px;color:#6b7280">มีคำถาม? ทักเราได้ที่ LINE OA <strong>@meowchat</strong> หรือตอบกลับอีเมลนี้ครับ</p>
    `),
  });
}

async function sendBillingSuccessEmail({ to, name, planName, amount, billingPeriod }) {
  const periodLabel = billingPeriod === 'annual' ? 'รายปี' : 'รายเดือน';
  await sendEmail({
    to,
    subject: '✅ ชำระเงิน MeowChat สำเร็จ',
    html: emailBase(`
      <p>สวัสดีครับคุณ <strong>${name || 'คุณ'}</strong></p>
      <p>ขอบคุณที่ใช้งาน MeowChat ครับ การชำระเงินของคุณสำเร็จแล้ว 🎉</p>
      <div class="info">
        <p>📦 แผน: <strong>${planName}</strong></p>
        <p>🔁 การเรียกเก็บ: <strong>${periodLabel}</strong></p>
        ${amount ? `<p>💳 ยอด: <strong>฿${Number(amount).toLocaleString()}</strong></p>` : ''}
        <p>🤖 บอทพร้อมรับข้อความแล้ว</p>
      </div>
      <p style="text-align:center;margin:24px 0"><a href="https://my.meowchat.store" class="btn">ไปหน้า Dashboard →</a></p>
    `),
  });
}

async function sendEscalationEmail({ to, shopName, customerName, message }) {
  await sendEmail({
    to,
    subject: `🔔 ลูกค้าขอคุยกับพนักงาน — ${shopName || 'ร้านของคุณ'}`,
    html: emailBase(`
      <p>มีลูกค้าต้องการพูดคุยกับพนักงานครับ</p>
      <div class="info">
        <p>🏪 ร้าน: <strong>${shopName || '-'}</strong></p>
        <p>👤 ลูกค้า: <strong>${customerName || 'ไม่ทราบชื่อ'}</strong></p>
        <p>💬 ข้อความ: "${message}"</p>
      </div>
      <p style="text-align:center;margin:24px 0"><a href="https://my.meowchat.store/handoff" class="btn">ดู Handoff →</a></p>
      <p style="font-size:13px;color:#6b7280">ตอบกลับลูกค้าได้ผ่านหน้า Handoff บน my.meowchat.store ครับ</p>
    `),
  });
}

module.exports = { sendWelcomeEmail, sendBillingSuccessEmail, sendEscalationEmail };
