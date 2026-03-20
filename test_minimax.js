require('dotenv').config({ path: __dirname + '/.env' });
const { processUserMessage } = require('./src/agent');

async function runTest() {
  console.log('Testing Minimax API with key:', process.env.MINIMAX_API_KEY ? 'Loaded' : 'Missing');
  try {
    const response = await processUserMessage('test_user', 'สวัสดีร้านขายส้มตำ มีอะไรแนะนำบ้าง', null, { businessType: 'food', aiPersonality: 'playful' });
    console.log('--- Test Answer ---');
    console.log(response);
    console.log('-------------------');
  } catch (error) {
    console.error('Test failed:', error);
  }
}

runTest();
