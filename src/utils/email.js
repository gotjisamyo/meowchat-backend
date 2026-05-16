const { Resend } = require('resend');

let resend = null;
function getResend() {
  if (!resend && process.env.RESEND_API_KEY) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const FROM = process.env.EMAIL_FROM || 'MeowChat <onboarding@resend.dev>';

async function sendEmail({ to, subject, html }) {
  const client = getResend();
  if (!client) {
    console.log(`[email] RESEND_API_KEY not set — skip: ${subject}`);
    return;
  }
  try {
    const { error } = await client.emails.send({ from: FROM, to, subject, html });
    if (error) console.error('[email] send error:', error);
    else console.log(`[email] sent → ${to}: ${subject}`);
  } catch (err) {
    console.error('[email] exception:', err.message);
  }
}

// ─── Base Layout ──────────────────────────────────────────────────────────────

function base({ preheader = '', body }) {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>MeowChat</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #07060F; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
  a { text-decoration: none; }
  img { display: block; border: 0; }
</style>
</head>
<body style="background:#07060F; margin:0; padding:0;">

<!-- Preheader (hidden preview text) -->
<div style="display:none;max-height:0;overflow:hidden;color:#07060F;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>

<!-- Outer wrapper -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07060F;min-height:100vh;">
<tr><td align="center" style="padding:40px 16px;">

  <!-- Card -->
  <table role="presentation" width="100%" style="max-width:560px;" cellpadding="0" cellspacing="0">

    <!-- ── HEADER ── -->
    <tr>
      <td style="
        background: linear-gradient(145deg, #0F0D1F 0%, #111827 100%);
        border: 1px solid rgba(49,195,106,0.15);
        border-bottom: none;
        border-radius: 20px 20px 0 0;
        padding: 36px 40px 28px;
        text-align: center;
      ">
        <!-- Logo mark — padding-based centering (Gmail-safe) -->
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 14px;">
          <tr>
            <td align="center" style="
              width:52px;
              background: linear-gradient(135deg, #1a2e1e 0%, #0f1f14 100%);
              border: 1.5px solid rgba(49,195,106,0.3);
              border-radius: 14px;
              font-size: 26px;
              line-height: 1;
              padding: 13px;
              text-align: center;
            ">🐱</td>
          </tr>
        </table>

        <div style="font-size:20px;font-weight:800;color:#FFFFFF;letter-spacing:-0.5px;">MeowChat</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.35);margin-top:3px;letter-spacing:0.5px;">AI ตอบแชทอัตโนมัติสำหรับธุรกิจไทย</div>
      </td>
    </tr>

    <!-- ── BODY ── -->
    <tr>
      <td style="
        background: #0D0B1E;
        border-left: 1px solid rgba(49,195,106,0.15);
        border-right: 1px solid rgba(49,195,106,0.15);
        padding: 36px 40px;
      ">
        ${body}
      </td>
    </tr>

    <!-- ── FOOTER ── -->
    <tr>
      <td style="
        background: #080713;
        border-left: 1px solid rgba(49,195,106,0.15);
        border-right: 1px solid rgba(49,195,106,0.15);
        border-bottom: 1px solid rgba(49,195,106,0.15);
        border-top: 1px solid rgba(255,255,255,0.05);
        border-radius: 0 0 20px 20px;
        padding: 24px 40px;
        text-align: center;
      ">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td align="center" style="padding-bottom:12px;">
              <a href="https://meowchat.store" style="color:rgba(255,255,255,0.3);font-size:12px;margin:0 10px;">meowchat.store</a>
              <span style="color:rgba(255,255,255,0.1);font-size:12px;">·</span>
              <a href="https://my.meowchat.store" style="color:rgba(255,255,255,0.3);font-size:12px;margin:0 10px;">Dashboard</a>
              <span style="color:rgba(255,255,255,0.1);font-size:12px;">·</span>
              <a href="https://meowchat.store/privacy" style="color:rgba(255,255,255,0.3);font-size:12px;margin:0 10px;">Privacy</a>
            </td>
          </tr>
          <tr>
            <td align="center">
              <p style="color:rgba(255,255,255,0.2);font-size:11px;line-height:1.6;">
                © 2026 MeowChat · ทุกสิทธิ์สงวน<br>
                อีเมลนี้ส่งถึงคุณเพราะคุณมีบัญชีกับ MeowChat
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── Shared components ─────────────────────────────────────────────────────────

function divider() {
  return `<div style="height:1px;background:linear-gradient(90deg,transparent,rgba(49,195,106,0.15),transparent);margin:28px 0;"></div>`;
}

function badge(text, color = '#31C36A') {
  return `<span style="
    display:inline-block;
    background:${color}18;
    border:1px solid ${color}35;
    color:${color};
    font-size:11px;
    font-weight:700;
    padding:3px 10px;
    border-radius:20px;
    letter-spacing:0.5px;
    text-transform:uppercase;
  ">${text}</span>`;
}

function infoBox(rows) {
  const rowsHtml = rows.map(([label, value]) => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.04);">
        <span style="color:rgba(255,255,255,0.4);font-size:12px;">${label}</span>
      </td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.04);text-align:right;">
        <span style="color:#FFFFFF;font-size:13px;font-weight:600;">${value}</span>
      </td>
    </tr>
  `).join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="
      background:rgba(255,255,255,0.03);
      border:1px solid rgba(255,255,255,0.07);
      border-radius:12px;
      margin:20px 0;
      overflow:hidden;
    ">
      ${rowsHtml}
    </table>
  `;
}

function ctaButton(text, url, color = '#31C36A') {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto;">
      <tr>
        <td style="
          background:${color};
          border-radius:12px;
          box-shadow: 0 0 24px ${color}40;
        ">
          <a href="${url}" style="
            display:block;
            padding:15px 36px;
            color:#07060F;
            font-size:15px;
            font-weight:800;
            letter-spacing:-0.2px;
            text-align:center;
          ">${text}</a>
        </td>
      </tr>
    </table>
  `;
}

function greeting(name) {
  return `<p style="color:rgba(255,255,255,0.9);font-size:15px;line-height:1.7;margin-bottom:6px;">สวัสดีครับคุณ <span style="white-space:nowrap;"><strong style="color:#FFFFFF;">${name || 'คุณ'}</strong> 👋</span></p>`;
}

// ─── Templates ────────────────────────────────────────────────────────────────

async function sendWelcomeEmail({ to, name }) {
  await sendEmail({
    to,
    subject: '🐱 ยินดีต้อนรับสู่ MeowChat — เริ่มต้นได้เลย!',
    html: base({
      preheader: 'AI ตอบแชท LINE OA 24/7 พร้อมใช้งานแล้ว — ทดลองฟรี 14 วัน',
      body: `
        ${greeting(name)}

        <p style="color:rgba(255,255,255,0.6);font-size:15px;line-height:1.7;margin-bottom:24px;">
          ยินดีต้อนรับสู่ <strong style="color:#31C36A;">MeowChat</strong> — AI ที่จะช่วยให้ร้านของคุณตอบแชท LINE OA ได้อัตโนมัติ ตลอด 24 ชั่วโมง โดยไม่ต้องจ้างแอดมินเพิ่มครับ
        </p>

        ${infoBox([
          ['ระยะทดลองใช้', '✅ ฟรี 14 วัน'],
          ['LINE OA ที่เชื่อมได้', '1 OA'],
          ['ข้อความ/เดือน', '2,000 ข้อความ'],
          ['บัตรเครดิต', 'ไม่ต้องใส่'],
        ])}

        <p style="color:rgba(255,255,255,0.5);font-size:13px;line-height:1.7;margin-bottom:4px;">
          🚀 <strong style="color:rgba(255,255,255,0.8);">เริ่มต้น 3 ขั้นตอน</strong>
        </p>
        <p style="color:rgba(255,255,255,0.45);font-size:13px;line-height:1.9;margin-bottom:24px;">
          1. เข้า Dashboard → ไปหน้า <strong style="color:rgba(255,255,255,0.7);">ตั้งค่าบอท</strong><br>
          2. เชื่อม LINE OA ของร้านกับ MeowChat<br>
          3. ทดลองส่งข้อความดูว่า AI ตอบได้ดีแค่ไหน
        </p>

        ${ctaButton('เริ่มตั้งค่าบอท →', 'https://my.meowchat.store')}

        ${divider()}

        <p style="color:rgba(255,255,255,0.35);font-size:12px;line-height:1.6;text-align:center;">
          มีคำถามหรือต้องการความช่วยเหลือ?<br>
          ทักเราได้ที่ LINE OA <strong style="color:rgba(255,255,255,0.5);">@meowchat</strong> หรือตอบกลับอีเมลนี้ครับ
        </p>
      `,
    }),
  });
}

async function sendBillingSuccessEmail({ to, name, planName, amount, billingPeriod }) {
  const isAnnual = billingPeriod === 'annual';
  const periodLabel = isAnnual ? 'รายปี' : billingPeriod === 'bank_transfer' ? 'โอนเงิน' : 'รายเดือน';
  const amountStr = amount ? `฿${Number(amount).toLocaleString()}` : '-';
  const nextDate = new Date();
  if (isAnnual) nextDate.setFullYear(nextDate.getFullYear() + 1);
  else nextDate.setMonth(nextDate.getMonth() + 1);
  const nextDateStr = nextDate.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });

  await sendEmail({
    to,
    subject: `✅ ชำระเงินสำเร็จ — แผน ${planName} พร้อมใช้งานแล้ว`,
    html: base({
      preheader: `ขอบคุณที่ไว้วางใจ MeowChat — แผน ${planName} ของคุณเปิดใช้งานแล้วครับ`,
      body: `
        <div style="text-align:center;margin-bottom:28px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 14px;">
            <tr>
              <td align="center" style="
                width:56px;
                background:rgba(49,195,106,0.1);
                border:1.5px solid rgba(49,195,106,0.3);
                border-radius:16px;
                font-size:28px;
                line-height:1;
                padding:14px;
                text-align:center;
              ">✅</td>
            </tr>
          </table>
          <div style="color:#31C36A;font-size:13px;font-weight:700;letter-spacing:0.5px;margin-bottom:6px;">ชำระเงินสำเร็จ</div>
          <div style="color:#FFFFFF;font-size:22px;font-weight:800;letter-spacing:-0.5px;">แผน ${planName}</div>
          <div style="color:rgba(255,255,255,0.4);font-size:13px;margin-top:4px;">พร้อมใช้งานแล้ว</div>
        </div>

        ${greeting(name)}
        <p style="color:rgba(255,255,255,0.6);font-size:15px;line-height:1.7;margin-bottom:24px;">
          ขอบคุณที่ไว้วางใจ MeowChat ครับ การชำระเงินของคุณสำเร็จแล้ว บอทพร้อมรับข้อความทันที
        </p>

        ${infoBox([
          ['แผนที่เลือก', `<span style="color:#31C36A;font-weight:700;">${planName}</span>`],
          ['ยอดชำระ', `<span style="color:#FFFFFF;">${amountStr}</span>`],
          ['รูปแบบการเรียกเก็บ', periodLabel],
          ['ต่ออายุถัดไป', nextDateStr],
        ])}

        ${ctaButton('ไปหน้า Dashboard →', 'https://my.meowchat.store')}

        ${divider()}

        <p style="color:rgba(255,255,255,0.35);font-size:12px;line-height:1.6;text-align:center;">
          ใบเสร็จฉบับนี้ออกโดย MeowChat · หากมีปัญหาเรื่องการชำระเงิน<br>
          ติดต่อเราได้ที่ <a href="mailto:support@meowchat.store" style="color:#31C36A;">support@meowchat.store</a>
        </p>
      `,
    }),
  });
}

async function sendEscalationEmail({ to, shopName, customerName, message }) {
  const now = new Date().toLocaleString('th-TH', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  await sendEmail({
    to,
    subject: `🔔 ลูกค้าขอคุยกับพนักงาน — ${shopName || 'ร้านของคุณ'}`,
    html: base({
      preheader: `${customerName || 'ลูกค้า'} ส่งข้อความ: "${message?.slice(0, 60)}..."`,
      body: `
        <div style="margin-bottom:24px;">
          <p style="margin:0 0 16px 0; line-height:2;"><span style="background:#261509; border:1px solid #FF8C42; border-radius:8px; padding:4px 14px; color:#FF8C42; font-size:12px; font-weight:700; letter-spacing:0.5px; white-space:nowrap;">⚠️&nbsp;ต้องการพนักงาน</span></p>

          <p style="color:#FFFFFF;font-size:18px;font-weight:700;margin-bottom:6px;">มีลูกค้าขอคุยกับพนักงานครับ</p>
          <p style="color:rgba(255,255,255,0.5);font-size:13px;">${now}</p>
        </div>

        ${infoBox([
          ['ร้าน', shopName || '-'],
          ['ชื่อลูกค้า', customerName || 'ไม่ทราบชื่อ'],
          ['ช่องทาง', 'LINE OA'],
        ])}

        <!-- Message bubble -->
        <div style="margin:20px 0;">
          <p style="color:rgba(255,255,255,0.4);font-size:11px;font-weight:600;letter-spacing:0.5px;margin-bottom:8px;text-transform:uppercase;">ข้อความล่าสุด</p>
          <div style="
            background:rgba(255,255,255,0.04);
            border:1px solid rgba(255,255,255,0.08);
            border-left:3px solid #FF8C42;
            border-radius:0 10px 10px 0;
            padding:14px 16px;
          ">
            <p style="color:rgba(255,255,255,0.85);font-size:14px;line-height:1.6;font-style:italic;">"${message || ''}"</p>
          </div>
        </div>

        ${ctaButton('ดูและตอบกลับลูกค้า →', 'https://my.meowchat.store/handoff', '#FF8C42')}

        ${divider()}

        <p style="color:rgba(255,255,255,0.35);font-size:12px;line-height:1.6;text-align:center;">
          แจ้งเตือนนี้ส่งอัตโนมัติจาก MeowChat เมื่อ AI ตรวจพบว่าลูกค้าต้องการพนักงาน<br>
          คุณสามารถตอบกลับได้จากหน้า <a href="https://my.meowchat.store/handoff" style="color:#FF8C42;">Handoff</a> ครับ
        </p>
      `,
    }),
  });
}

module.exports = { sendWelcomeEmail, sendBillingSuccessEmail, sendEscalationEmail };
