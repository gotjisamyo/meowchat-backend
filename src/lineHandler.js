const line = require('@line/bot-sdk');
const { processUserMessage } = require('./agent');
const { saveOrder, getOrdersByLineId } = require('./db');

async function handleLineEvent(event, lineConfig) {
  // Ignore non-message events
  if (event.type !== 'message') {
    return { type: event.type, ignored: true };
  }

  const client = new line.Client(lineConfig);
  const userId = event.source.userId;
  const messageText = event.message.text;

  console.log(`📩 Message from ${userId}: ${messageText}`);

  try {
    // Process message through AI Agent
    const aiResponse = await processUserMessage(userId, messageText);

    // Check if it's an order
    if (aiResponse.isOrder) {
      saveOrder({
        lineId: userId,
        product: aiResponse.product,
        quantity: aiResponse.quantity,
        price: aiResponse.price,
        details: aiResponse.details,
        status: 'pending'
      });
    }

    // Send reply
    const replyMessage = {
      type: 'text',
      text: aiResponse.message
    };

    await client.replyMessage(event.replyToken, replyMessage);
    
    return { success: true, isOrder: aiResponse.isOrder };
  } catch (error) {
    console.error('Error handling LINE event:', error);
    
    // Send error message
    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ขออภัยค่ะ มีปัญหาในการประมวลผล กรุณาลองอีกครั้งนะคะ 💕'
      });
    } catch (replyError) {
      console.error('Error sending reply:', replyError);
    }
    
    return { success: false, error: error.message };
  }
}

module.exports = { handleLineEvent };
