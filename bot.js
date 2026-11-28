import 'dotenv/config';

const BOT = process.env.BOT_TOKEN, URL = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL;
const api = (method, body) => fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());

let offset = 0;
console.log('Bot running…');
for (;;) {
  try {
    const r = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    for (const u of r.result || []) {
      offset = u.update_id + 1;
      const m = u.message;
      if (m?.text?.startsWith('/start')) {
        await api('sendMessage', {
          chat_id: m.chat.id,
          text: 'Welcome to DOGS! Tap the button below to start mining.',
          reply_markup: { inline_keyboard: [[{ text: '⛏ Open DOGS', web_app: { url: URL } }]] },
        });
      }
    }
  } catch (e) {
    console.error(e.message);
    await new Promise(r => setTimeout(r, 3000));
  }
}
