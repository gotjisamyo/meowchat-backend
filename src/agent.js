// AI Agent Logic - Google Gemini API Integration
const axios = require('axios');
const db = require('./db');

let geminiClient = null;

// Business type specific prompts
const businessPrompts = {
  general: `
- ให้คำแนะนำสินค้าทั่วไป
- ตอบคำถามเรื่องสินค้า ราคา การสั่งซื้อ
- บริการลูกค้าทั่วไป`,

  clothing: `
- แนะนำเสื้อผ้า ขนาด สี ลาย
- ถามไซส์ สีที่ต้องการ
- แนะนำเสื้อผ้าที่เข้ากัน
- บอกวิธีวัดขนาด`,

  food: `
- แนะนำเมนูอาหาร
- ถามว่าทานที่ร้านหรือพับเพียบ (takeaway/delivery)
- แจ้งเวลาในการจัดเตรียมอาหาร
- บอกส่วนผสมที่แพ้อาหาร`,

  coffee: `
- แนะนำเมนูกาแฟ ชา นม
- ถามว่าเย็นหรือร้อน หวานน้อยหวานปกติ
- แนะนำเมนูยอดนิยม
- บอกเวลาเปิด-ปิด`,

  electronics: `
- แนะนำอุปกรณ์อิเล็กทรอนิกส์
- ถามการใช้งาน การรับประกัน
- แนะนำอุปกรณ์เสริม
- บอกสเปค ความเข้ากันได้`,

  beauty: `
- แนะนำผลิตภัณฑ์ความสวยความงาม
- ถามประเภทผิว ความต้องการ
- แนะนำสินค้าที่เหมาะสม
- บอกวิธีใช้ ผลข้างเคียง`,

  hotel: `
- ให้ข้อมูลห้องพัก ราคา
- ถามวันที่เช็คอิน เช็คเอาท์
- แนะนำห้องที่เหมาะกับจำนวนคน
- บอกสิ่งอำนวยความสะดวก`,

  clinic: `
- ให้ข้อมูลบริการทางการแพทย์
- ถามอาการเบื้องต้น
- นัดหมายแพทย์
- บอกเวลาเปิดให้บริการ`,

  education: `
- ให้ข้อมูลหลักสูตร คอร์สเรียน
- ถามระดับความรู้ วัย
- แนะนำคอร์สที่เหมาะสม
- บอกค่าเรียน ตารางเรียน`,

  automotive: `
- แนะนำอะไหล่ บริการซ่อม
- ถามยี่ห้อ รุ่น ปัญหา
- แนะนำบริการที่เหมาะสม
- บอกระยะเวลา ค่าใช้จ่าย`
};

// AI Personality prompts
const personalityPrompts = {
  friendly: `
- ตอบอ่อนหวาน อบอุ่น
- ใช้อิโมจิบ่อย เช่น 💕 😊 🐱
- พูดเป็นกันเอง
- ให้ความรู้สึกเหมือนคุยกับเพื่อน`,

  professional: `
- ตอบตรงไปตรงมา การะชัด
- ใช้ภาษาทางการ
- ให้ข้อมูลครบถ้วน ถูกต้อง
- เน้นประสิทธิภาพการให้บริการ`,

  playful: `
- ตอบขำขัน สนุกสนาน
- ใช้อิโมจิเยอะมาก
- พูดเล่นได้ แต่ยังให้บริการดี
- ทำให้ลูกค้าหัวเราะ`,

  gentle: `
- ตอบอ่อนโยน ใส่ใจ
- ถามอย่างนุ่มนวล
- ให้ความรู้สึกดี ไม่กดดัน
- ช่วยเหลืออย่างเข้าใจ`
};

// Response style prompts
const responseStylePrompts = {
  short: `
- ตอบกระชับ ไม่เกิน 2-3 ประโยค
- ได้ใจความสำคัญ
- ไม่อธิบายยืดยาว`,

  balanced: `
- ตอบพอดีๆ ไม่สั้นไม่ยาว
- ให้ข้อมูลที่จำเป็น
- สมดุลระหว่างข้อมูลและความสนุก`,

  detailed: `
- ตอบละเอียด อธิบายเยอะ
- ให้ข้อมูลครบถ้วน
- อธิบายขั้นตอนชัดเจน
- ไม่รีบร้อน`,

  emoji: `
- ใช้อิโมจิเยอะมากๆ
- ทำให้ข้อความดูสนุก
- มีอารมณ์ขัน
- ตอบแล้วสดใส`
};

// Get business type prompt
function getBusinessPrompt(businessType) {
  return businessPrompts[businessType] || businessPrompts.general;
}

// Get personality prompt
function getPersonalityPrompt(personality) {
  return personalityPrompts[personality] || personalityPrompts.friendly;
}

// Get response style prompt
function getResponseStylePrompt(style) {
  return responseStylePrompts[style] || responseStylePrompts.balanced;
}

// Initialize AI client
function initAI() {
  if (process.env.MINIMAX_API_KEY) {
    console.log('✅ Gemini API initialized');
  }
}

// Process user message and generate AI response
async function processUserMessage(userId, message, shopId = null, options = {}) {
  const {
    businessType = 'general',
    aiPersonality = 'friendly',
    aiResponseStyle = 'balanced',
    aiCustomKnowledge = ''
  } = options;

  // Initialize AI if not yet
  if (!geminiClient) {
    initAI();
  }

  // Get business type specific prompt
  const businessPrompt = getBusinessPrompt(businessType);
  const personalityPrompt = getPersonalityPrompt(aiPersonality);
  const responseStylePrompt = getResponseStylePrompt(aiResponseStyle);

  // Fetch real products from database
  let productInfo = '';
  if (shopId) {
    try {
      const products = db.getProducts({ shopId: shopId });
      if (products && products.length > 0) {
        productInfo = '\n\n📦 ข้อมูลสินค้าจริงของร้าน:\n';
        products.forEach((p, i) => {
          productInfo += `${i + 1}. ${p.name} - ฿${p.price}`;
          if (p.stock > 0) productInfo += ` (มีสินค้า: ${p.stock} ชิ้น)`;
          else productInfo += ' (สินค้าหมด)';
          if (p.description) productInfo += ` - ${p.description}`;
          productInfo += '\n';
        });
      }
    } catch (e) {
      console.log('No products found or error:', e.message);
    }
  }

  // Check if message contains order keywords
  const orderKeywords = ['สั่งซื้อ', 'สั่ง', 'ซื้อ', 'order', 'ต้องการ', 'ขอซื้อ', 'จอง', 'มี', 'ไหม'];
  const isOrderIntent = orderKeywords.some(keyword =>
    message.toLowerCase().includes(keyword.toLowerCase())
  );

  // If Gemini API key is available, use it
  if (process.env.GEMINI_API_KEY) {
    try {
      // Build the prompt
      const systemPrompt = `คุณเป็นผู้ช่วย AI สำหรับร้านค้าไทย ชื่อ "แมวส้ม" (MeowChat) 

ประเภทธุรกิจ: ${businessType}
${businessPrompt}

นิสัย/บุคลิก:
${personalityPrompt}

รูปแบบการตอบ:
${responseStylePrompt}

ข้อมูลเพิ่มเติมของร้าน:
${aiCustomKnowledge || '- ไม่มีข้อมูลเพิ่มเติม'}

${productInfo ? productInfo : ''}

กฎการตอบ:
1. ตอบกลับอย่างอ่อนหวาน ใช้ภาษาไทย
2. ถ้าลูกค้าถามเรื่องสินค้า/บริการ ให้ตอบตามข้อมูลที่มีจริง
3. ถ้าลูกค้าต้องการสั่งซื้อ/ใช้บริการ ให้ถามข้อมูลที่จำเป็น
4. ถ้าไม่รู้ ให้บอกว่า "ขอโทษค่ะ ขอตรวจสอบแล้วจะตอบกลับนะคะ"
5. จบคำตอบด้วยอิโมจิที่เหมาะสม เช่น 💕 😊 🐱`;

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [
            {
              parts: [
                { text: systemPrompt + "\n\nUser: " + message }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024
          }
        }
      );

      console.log('Gemini response:', JSON.stringify(response.data));
      
      // Check for valid response
      if (!response.data || !response.data.candidates || !response.data.candidates[0]) {
        console.error('Invalid Gemini response:', response.data);
        throw new Error('Invalid API response');
      }

      const aiMessage = response.data.candidates[0].content.parts[0].text;

      // Simple order detection
      if (isOrderIntent) {
        return {
          message: aiMessage + '\n\n📝 ข้อมูลการสั่งซื้อถูกบันทึกแล้วค่ะ 💕',
          isOrder: true,
          product: extractProduct(message),
          quantity: extractQuantity(message),
          price: extractPrice(message),
          details: message
        };
      }

      return {
        message: aiMessage,
        isOrder: false
      };
    } catch (error) {
      console.error('Gemini API error:', error.response?.data || error.message);
    }
  }

  // Fallback: Simple rule-based responses
  if (isOrderIntent) {
    return {
      message: 'ได้ค่ะ! กำลังบันทึกคำสั่งซื้อให้นะคะ 💕\n\nกรุณารอสักครู่ ทีมงานจะติดต่อกลับไปยืนยันคำสั่งซื้อนะคะ',
      isOrder: true,
      product: extractProduct(message),
      quantity: extractQuantity(message),
      price: extractPrice(message),
      details: message
    };
  }

  // Default responses
  const defaultResponses = [
    'สวัสดีค่ะ! มีอะไรให้ช่วยไหมคะ? 💕\n\n- สอบถามสินค้า\n- สั่งซื้อ\n- สอบถามการจัดส่ง',
    'ยินดีต้อนรับค่ะ! 🐱\n\nสามารถสอบถามข้อมูลหรือสั่งซื้อสินค้าได้เลยค่ะ 😊',
    'สวัสดีค่ะ! หนูชื่อแมวส้ม พร้อมช่วยเหลือค่ะ 💕\n\nมีอะไรให้ช่วยไหมคะ?'
  ];

  return {
    message: defaultResponses[Math.floor(Math.random() * defaultResponses.length)],
    isOrder: false
  };
}

// Simple extraction helpers
function extractProduct(message) {
  const productPatterns = [
    /สินค้า[:\s]+(.+?)(?:\s|$)/i,
    /ซื้อ[:\s]+(.+?)(?:\s|$)/i,
    /(.+?)\s+\d+\s*ชิ้น/i
  ];

  for (const pattern of productPatterns) {
    const match = message.match(pattern);
    if (match) return match[1].trim();
  }

  return 'Unknown Product';
}

function extractQuantity(message) {
  const quantityMatch = message.match(/(\d+)\s*ชิ้น|(\d+)\s*อัน|(\d+)\s*ชุด/i);
  if (quantityMatch) {
    return parseInt(quantityMatch[1] || quantityMatch[2] || quantityMatch[3]);
  }
  return 1;
}

function extractPrice(message) {
  const priceMatch = message.match(/(\d+)\s*บาท|ราคา\s*(\d+)/i);
  if (priceMatch) {
    return parseInt(priceMatch[1] || priceMatch[2]);
  }
  return 0;
}

module.exports = { processUserMessage, initAI };
