// Mock LINE Integration for Demo
// Replace with real credentials when available

const MOCK_RESPONSES = {
  'สวัสดี': 'สวัสดีค่ะ! 🐱 ยินดีต้อนรับสู่ MeowChat!',
  'สินค้า': 'เรามีสินค้าหลากหลายเลยค่ะ! สนใจอะไรเป็นพิเศษไหมคะ?',
  'ราคา': 'ราคาเริ่มต้นที่ ฿999/เดือนค่ะ!',
  'ซื้อ': 'สนใจซื้อสินค้าค่ะ? บอกได้เลยค่ะ!',
  'default': 'ขอบคุณที่ติดต่อมาค่ะ! 💕 มีอะไรให้ช่วยอีกไหมคะ?'
};

function getMockResponse(message) {
  const msg = message.toLowerCase();
  for (const [key, value] of Object.entries(MOCK_RESPONSES)) {
    if (msg.includes(key)) {
      return value;
    }
  }
  return MOCK_RESPONSES.default;
}

module.exports = { getMockResponse, MOCK_RESPONSES };
