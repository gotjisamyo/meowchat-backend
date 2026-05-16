const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const INSPECT_DB = path.join(ROOT, 'inspect_db.js');
const EMAIL = 'god@meowchat.store';
const SHOP_ID = 'a905297e43ed648c';
const PLAN_ID = 4; // Business

function getConnectionString() {
  const text = fs.readFileSync(INSPECT_DB, 'utf8');
  const match = text.match(/connectionString:\s*'([^']+)'/);
  if (!match) throw new Error('Could not find connection string in inspect_db.js');
  return match[1];
}

function daysAgo(days, hour = 10, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const conversations = [
  {
    daysAgo: 1,
    hour: 9,
    customerName: 'Mint',
    lineUserId: 'god-mock-001',
    escalated: false,
    messages: [
      ['user', 'สวัสดีค่ะ ขอเช็กราคาสินค้าตัว premium หน่อยค่ะ'],
      ['assistant', 'ได้เลยค่ะ รุ่น premium ราคาเริ่มต้น 1,990 บาท ส่งฟรีวันนี้นะคะ'],
      ['user', 'ถ้าสั่งวันนี้ส่งด่วนได้ไหม แล้วมีโปรผ่อนหรือเปล่า'],
      ['assistant', 'ส่งด่วนในกรุงเทพได้ภายในวันนี้ค่ะ และมีโปรผ่อน 0% 3 เดือนที่ลิงก์ https://meowchat.store/promo/april']
    ]
  },
  {
    daysAgo: 2,
    hour: 12,
    customerName: 'Boss',
    lineUserId: 'god-mock-002',
    escalated: false,
    messages: [
      ['user', 'มีสต็อกพร้อมส่งไหมครับ อยากได้สีดำ'],
      ['assistant', 'มีสต็อกพร้อมส่งค่ะ สีดำเหลือ 8 ชิ้น สนใจให้ส่งลิงก์สั่งซื้อไหมคะ'],
      ['user', 'ส่งลิงก์มาได้เลยครับ'],
      ['assistant', 'สั่งซื้อได้ที่ https://meowchat.store/catalog/premium ค่ะ']
    ]
  },
  {
    daysAgo: 3,
    hour: 15,
    customerName: 'May',
    lineUserId: 'god-mock-003',
    escalated: true,
    messages: [
      ['user', 'ออเดอร์เมื่อวานยังไม่เข้าเลย ขอคุยกับเจ้าหน้าที่ค่ะ'],
      ['assistant', 'ขออภัยในความล่าช้าค่ะ เดี๋ยวประสานเจ้าหน้าที่ให้ทันทีนะคะ'],
      ['user', 'ขอบคุณค่ะ รบกวนตามให้หน่อย'],
      ['assistant', 'สร้าง handoff ให้แล้วค่ะ ทีมงานจะติดต่อกลับเร็วที่สุด']
    ]
  },
  {
    daysAgo: 4,
    hour: 20,
    customerName: 'Nok',
    lineUserId: 'god-mock-004',
    escalated: false,
    messages: [
      ['user', 'ตอนนี้มีโปรอะไรบ้างคะ'],
      ['assistant', 'วันนี้มีโปรลด 15% และส่งฟรีค่ะ ดูรายละเอียดได้ที่ https://meowchat.store/promo/april'],
      ['user', 'ถ้าซื้อ 2 ชิ้นมีของแถมไหม'],
      ['assistant', 'มีของแถมเป็นชุดดูแลสินค้า 1 ชุดค่ะ']
    ]
  },
  {
    daysAgo: 5,
    hour: 11,
    customerName: 'Pond',
    lineUserId: 'god-mock-005',
    escalated: false,
    messages: [
      ['user', 'รีวิวรุ่นนี้ดีไหมครับ'],
      ['assistant', 'ลูกค้าส่วนใหญ่ชอบเรื่องความคุ้มค่าและบริการหลังการขายค่ะ อ่านรีวิวได้ที่ https://meowchat.store/review'],
      ['user', 'โอเค เดี๋ยวดูรีวิวก่อน'],
      ['assistant', 'ได้เลยค่ะ ถ้าพร้อมสั่งเมื่อไรทักมาได้เลย']
    ]
  },
  {
    daysAgo: 6,
    hour: 14,
    customerName: 'Jane',
    lineUserId: 'god-mock-006',
    escalated: false,
    messages: [
      ['user', 'ถ้าซื้อสำหรับบริษัทออกใบกำกับได้ไหม'],
      ['assistant', 'ออกใบกำกับภาษีเต็มรูปแบบได้ค่ะ รบกวนแจ้งชื่อบริษัทและเลขผู้เสียภาษีตอนสั่งซื้อ'],
      ['user', 'มีราคาพิเศษสำหรับซื้อหลายชิ้นไหม'],
      ['assistant', 'หากสั่ง 5 ชิ้นขึ้นไปมีราคาพิเศษค่ะ เดี๋ยวส่งรายละเอียดให้ทางแชตนี้ได้เลย']
    ]
  },
  {
    daysAgo: 7,
    hour: 19,
    customerName: 'Ice',
    lineUserId: 'god-mock-007',
    escalated: false,
    messages: [
      ['user', 'ขอเทียบรุ่นธรรมดากับ premium หน่อยค่ะ'],
      ['assistant', 'รุ่น premium จะได้ฟีเจอร์เพิ่มและรับประกันยาวกว่าค่ะ ถ้าต้องการดูตารางเทียบส่งให้ได้เลย'],
      ['user', 'ขอดูตารางเทียบค่ะ'],
      ['assistant', 'ส่งให้แล้วค่ะ และถ้าสนใจรุ่น premium มีโปรพิเศษวันนี้ด้วยนะคะ']
    ]
  },
  {
    daysAgo: 9,
    hour: 10,
    customerName: 'Gun',
    lineUserId: 'god-mock-008',
    escalated: true,
    messages: [
      ['user', 'สินค้าเคลมยังไงครับ'],
      ['assistant', 'สามารถแจ้งเลขออเดอร์และอาการได้เลยค่ะ เดี๋ยวช่วยตรวจสอบให้'],
      ['user', 'ขอคุยกับเจ้าหน้าที่ดีกว่าครับ'],
      ['assistant', 'รับทราบค่ะ กำลังโอนให้เจ้าหน้าที่ดูแลต่อ']
    ]
  },
  {
    daysAgo: 11,
    hour: 16,
    customerName: 'Fern',
    lineUserId: 'god-mock-009',
    escalated: false,
    messages: [
      ['user', 'มีเก็บปลายทางไหมคะ'],
      ['assistant', 'มีบริการเก็บปลายทางบางพื้นที่ค่ะ ถ้าแจ้งจังหวัดมาได้จะเช็กให้'],
      ['user', 'อยู่เชียงใหม่ค่ะ'],
      ['assistant', 'เชียงใหม่รองรับเก็บปลายทางค่ะ ค่าส่งเริ่มต้น 60 บาท']
    ]
  },
  {
    daysAgo: 13,
    hour: 13,
    customerName: 'Tom',
    lineUserId: 'god-mock-010',
    escalated: false,
    messages: [
      ['user', 'ซื้อวันนี้รับของพรุ่งนี้ไหม'],
      ['assistant', 'หากชำระเงินก่อน 15:00 น. มีโอกาสได้รับพรุ่งนี้ค่ะ'],
      ['user', 'โอเค เดี๋ยวสั่งเลย'],
      ['assistant', 'ขอบคุณค่ะ สามารถกดสั่งผ่าน https://meowchat.store/catalog/premium ได้เลย']
    ]
  }
];

async function main() {
  const client = new Client({
    connectionString: getConnectionString(),
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    await client.query('BEGIN');

    const userRes = await client.query('SELECT id FROM users WHERE email = $1', [EMAIL]);
    if (userRes.rows.length === 0) {
      throw new Error(`User ${EMAIL} not found`);
    }
    const userId = userRes.rows[0].id;

    await client.query(
      `UPDATE users
       SET role = 'admin', failed_login_attempts = 0, login_locked_until = NULL
       WHERE id = $1`,
      [userId]
    );

    await client.query(
      `UPDATE shops
       SET line_channel_id = COALESCE(NULLIF(line_channel_id, ''), 'god-analytics-demo')
       WHERE id = $1 AND user_id = $2`,
      [SHOP_ID, userId]
    );

    const paymentRes = await client.query(
      `INSERT INTO payment_notifications (
          shop_id, payer_name, amount, transfer_date, bank_name, account_name, account_number, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', NOW() - INTERVAL '7 days', NOW())
        RETURNING id`,
      [SHOP_ID, 'Got Analytics Seed', 2490, new Date().toISOString().slice(0, 10), 'SCB', 'MeowChat Demo', '123-4-56789-0']
    );

    await client.query(`DELETE FROM subscriptions WHERE shop_id = $1`, [SHOP_ID]);
    await client.query(
      `INSERT INTO subscriptions (
        shop_id, plan_id, status, start_date, end_date, payment_method, payment_status, "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, 'active', NOW() - INTERVAL '7 days', NOW() + INTERVAL '30 days', 'bank_transfer', 'paid', NOW() - INTERVAL '7 days', NOW()
      )`,
      [SHOP_ID, PLAN_ID]
    );

    await client.query(
      `DELETE FROM conversation_messages
       WHERE conversation_id IN (SELECT id FROM conversations WHERE shop_id = $1)`,
      [SHOP_ID]
    );
    await client.query(`DELETE FROM conversations WHERE shop_id = $1`, [SHOP_ID]);
    await client.query(`DELETE FROM broadcasts WHERE shop_id = $1`, [SHOP_ID]);
    await client.query(`DELETE FROM shop_events WHERE shop_id = $1`, [SHOP_ID]);

    for (const item of conversations) {
      const createdAt = daysAgo(item.daysAgo, item.hour);
      const convRes = await client.query(
        `INSERT INTO conversations (
          shop_id, line_user_id, customer_name, status, escalated, created_at, updated_at
        ) VALUES ($1, $2, $3, 'closed', $4, $5, $5) RETURNING id`,
        [SHOP_ID, item.lineUserId, item.customerName, item.escalated ? 1 : 0, createdAt]
      );
      const conversationId = convRes.rows[0].id;

      for (let i = 0; i < item.messages.length; i += 1) {
        const [role, content] = item.messages[i];
        const messageTime = new Date(createdAt.getTime() + i * 5 * 60 * 1000);
        await client.query(
          `INSERT INTO conversation_messages (conversation_id, role, content, created_at)
           VALUES ($1, $2, $3, $4)`,
          [conversationId, role, content, messageTime]
        );
      }

      await client.query(
        `INSERT INTO shop_events (shop_id, event, meta, created_at)
         VALUES ($1, $2, $3, $4)`,
        [SHOP_ID, item.escalated ? 'handoff_requested' : 'chat_resolved', JSON.stringify({ lineUserId: item.lineUserId }), createdAt]
      );
    }

    await client.query(
      `INSERT INTO broadcasts (shop_id, message, recipient_count, sent_count, status, created_at, sent_at, image_url)
       VALUES
       ($1, 'โปรปลายเดือน ลด 15% สำหรับรุ่น premium', 120, 117, 'sent', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days', 'https://meowchat.store/promo/april'),
       ($1, 'รีวิวลูกค้าจริง + ของแถมพิเศษประจำสัปดาห์', 120, 114, 'sent', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', 'https://meowchat.store/review')`,
      [SHOP_ID]
    );

    await client.query(
      `INSERT INTO shop_events (shop_id, event, meta, created_at)
       VALUES
       ($1, 'broadcast_sent', '{"name":"end-of-month-promo"}', NOW() - INTERVAL '5 days'),
       ($1, 'checkout_started', '{"source":"promo"}', NOW() - INTERVAL '1 day'),
       ($1, 'checkout_completed', '{"source":"promo"}', NOW() - INTERVAL '1 day')`,
      [SHOP_ID]
    );

    await client.query('COMMIT');

    const summary = await client.query(
      `SELECT
         (SELECT role FROM users WHERE id = $1) AS role,
         (SELECT p.name FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.shop_id = $2 AND s.status = 'active' ORDER BY s."createdAt" DESC LIMIT 1) AS plan_name,
         (SELECT COUNT(*) FROM conversations WHERE shop_id = $2) AS conversations,
         (SELECT COUNT(*) FROM conversation_messages cm JOIN conversations c ON c.id = cm.conversation_id WHERE c.shop_id = $2) AS messages,
         (SELECT COUNT(*) FROM broadcasts WHERE shop_id = $2) AS broadcasts,
         (SELECT COUNT(*) FROM payment_notifications WHERE shop_id = $2 AND status = 'approved') AS approved_payments`,
      [userId, SHOP_ID]
    );

    console.log(JSON.stringify(summary.rows[0], null, 2));
    console.log(JSON.stringify({ paymentNotificationId: paymentRes.rows[0].id }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
