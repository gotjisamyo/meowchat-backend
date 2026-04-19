const axios = require('axios');

async function pushToLine(userId, text, accessToken) {
  if (!userId || !accessToken) return;
  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to: userId, messages: [{ type: 'text', text }] },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` } }
  ).catch(err => console.error('[LINE push error]', err.response?.data || err.message));
}

module.exports = { pushToLine };
