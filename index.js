// index.js
import express from 'express';
import fetchPkg from 'node-fetch';

// use global fetch if Node provides it (Node 18+), else node-fetch
const fetchFn = (typeof fetch !== 'undefined') ? fetch : fetchPkg;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const HOST_URL = process.env.HOST_URL; // e.g. https://your-app.onrender.com
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required');
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---------------------------------------------------------------------
// STATE (in-memory)
// ---------------------------------------------------------------------

// customer sessions: chatId -> { step, amount, name, phone, address, coords, ... }
const sessions = new Map();

// admin message map: adminMessageId -> { customerChatId, orderId }
const adminMessageMap = new Map();

// simple auto-increment for order ids (for display)
let orderCounter = 1;

// ---------------------------------------------------------------------
// HELPER FUNCTIONS
// ---------------------------------------------------------------------

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {});
  }
  return sessions.get(chatId);
}

async function tgSendMessage(chatId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...extra
    })
  });
}

async function tgEditMessageText(chatId, messageId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      ...extra
    })
  });
}

async function tgSendLocation(chatId, latitude, longitude) {
  return fetchFn(`${TELEGRAM_API}/sendLocation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      latitude,
      longitude
    })
  });
}

// inline keyboards
const AMOUNTS = ['₱500', '₱700', '₱1,000', 'Half G', '1G'];

function amountInlineKeyboard() {
  return {
    inline_keyboard: AMOUNTS.map(a => [{ text: a, callback_data: `amt:${a}` }])
  };
}

function nameInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '👤 Use my Telegram name', callback_data: 'name:auto' }],
      [{ text: '⌨️ I will type my name', callback_data: 'name:manual' }]
    ]
  };
}

function confirmInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirm', callback_data: 'order:confirm' },
        { text: '❌ Cancel', callback_data: 'order:cancel' }
      ]
    ]
  };
}

function restartInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔁 Start new order', callback_data: 'order:restart' }]
    ]
  };
}

// reverse geocode
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
    const res = await fetchFn(url, {
      headers: { 'User-Agent': 'IceOrderBot/1.0 (mailto:you@example.com)' }
    });
    if (!res.ok) return `${lat}, ${lon}`;
    const data = await res.json();
    return data.display_name || `${lat}, ${lon}`;
  } catch (err) {
    console.error('Geocoding error:', err);
    return `${lat}, ${lon}`;
  }
}

// send order to admin + store admin message -> customer
async function sendOrderToAdmin(session, from) {
  if (!ADMIN_CHAT_ID || Number.isNaN(ADMIN_CHAT_ID)) {
    console.error('ADMIN_CHAT_ID not configured, skipping admin send.');
    return;
  }

  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Manila'
  });

  const coordsText = session.coords
    ? `${session.coords.latitude}, ${session.coords.longitude}`
    : 'N/A';

  // create an order id
  const orderId = orderCounter++;

  const adminText = `
🧊 NEW ORDER (#${orderId})

💰 Amount: ${session.amount || 'N/A'}
👤 Name: ${session.name || 'N/A'}
📱 Phone: ${session.phone || 'N/A'}
📍 Address: ${session.address || 'N/A'}
🗺️ Coords: ${coordsText}

💡 To send tracking, just REPLY to this message with the link.
⏰ ${timestamp}
  `.trim();

  // send to admin
  const resp = await tgSendMessage(ADMIN_CHAT_ID, adminText);
  const data = await resp.json().catch(() => null);

  // if sent OK, remember which admin message is tied to which customer
  if (data && data.ok) {
    const adminMessageId = data.result.message_id;
    adminMessageMap.set(adminMessageId, {
      customerChatId: from.id,
      orderId
    });
  }

  // optional: also send location to admin if available
  if (session.coords) {
    await tgSendLocation(
      ADMIN_CHAT_ID,
      session.coords.latitude,
      session.coords.longitude
    );
  }
}

// ---------------------------------------------------------------------
// UPDATE HANDLERS
// ---------------------------------------------------------------------

// regular text / commands
async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from;
  const text = message.text || '';
  const session = getSession(chatId);

  // 1) ADMIN replying to a specific order (swipe-to-reply)
  if (chatId === ADMIN_CHAT_ID && message.reply_to_message) {
    const repliedMsgId = message.reply_to_message.message_id;
    const info = adminMessageMap.get(repliedMsgId);

    if (!info) {
      await tgSendMessage(chatId, 'I don’t know which customer this is for.');
      return;
    }

    // forward admin reply to customer
    await tgSendMessage(
      info.customerChatId,
      `🚚 Update for your order #${info.orderId}:\n${text}`
    );

    await tgSendMessage(
      chatId,
      `✅ Sent update to customer of order #${info.orderId}`
    );
    return;
  }

  // 2) customer start
  if (text === '/start') {
    sessions.set(chatId, { step: 'choose_amount' });
    await tgSendMessage(
      chatId,
      '🧊 Welcome to IceOrderBot!\n\nPlease select an amount:',
      { reply_markup: amountInlineKeyboard() }
    );
    return;
  }

  // 3) customer is typing name manually
  if (session.step === 'wait_name_text') {
    session.name = text.trim();
    session.step = 'request_phone';

    await tgSendMessage(chatId, `Thanks, ${session.name}! Now please share your phone:`);
    await tgSendMessage(chatId, 'Tap the button to share your phone:', {
      reply_markup: {
        keyboard: [
          [{ text: '📱 Share Phone Number', request_contact: true }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    return;
  }

  // 4) customer typed while waiting for confirm
  if (session.step === 'confirm') {
    await tgSendMessage(chatId, 'Please tap ✅ Confirm or ❌ Cancel above.');
    return;
  }

  // 5) fallback
  await tgSendMessage(chatId, 'Please /start to begin an order.', {
    reply_markup: amountInlineKeyboard()
  });
}

// customer shared contact
async function handleContact(message) {
  const chatId = message.chat.id;
  const session = getSession(chatId);
  if (session.step !== 'request_phone') return;

  const phone = message.contact?.phone_number;
  if (!phone) {
    await tgSendMessage(chatId, 'No phone number received. Please try again.');
    return;
  }

  session.phone = phone;
  session.step = 'request_location';

  await tgSendMessage(chatId, 'Great 👍 Now share your delivery location:', {
    reply_markup: {
      keyboard: [
        [{ text: '📍 Share Location', request_location: true }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
}

// customer shared location
async function handleLocation(message) {
  const chatId = message.chat.id;
  const session = getSession(chatId);
  if (session.step !== 'request_location') return;

  const loc = message.location;
  if (!loc) {
    await tgSendMessage(chatId, 'Location not received, please try again.');
    return;
  }

  const { latitude, longitude } = loc;
  session.coords = { latitude, longitude };

  const address = await reverseGeocode(latitude, longitude);
  session.address = address;
  session.step = 'confirm';

  const summary = `
📋 Order Summary:

💰 Amount: ${session.amount || 'N/A'}
👤 Name: ${session.name || 'N/A'}
📱 Phone: ${session.phone || 'N/A'}
📍 Address: ${address}
🗺️ Coordinates: ${latitude}, ${longitude}
  `.trim();

  await tgSendMessage(chatId, summary, {
    reply_markup: confirmInlineKeyboard()
  });

  // remove reply keyboard
  await tgSendMessage(chatId, 'Please confirm above 👆', {
    reply_markup: { remove_keyboard: true }
  });
}

// inline button clicks
async function handleCallbackQuery(cbq) {
  const data = cbq.data;
  const message = cbq.message;
  const from = cbq.from;
  const chatId = message.chat.id;
  const messageId = message.message_id;

  const session = getSession(chatId);

  // amount
  if (data.startsWith('amt:')) {
    const amount = data.slice(4);
    session.amount = amount;
    session.step = 'ask_name';

    await tgEditMessageText(
      chatId,
      messageId,
      `Amount selected: ${amount}\n\nHow should I get your name?`,
      { reply_markup: nameInlineKeyboard() }
    );
    return;
  }

  // name: auto
  if (data === 'name:auto') {
    const fullName =
      [from.first_name, from.last_name].filter(Boolean).join(' ').trim() ||
      from.username ||
      'Customer';

    session.name = fullName;
    session.step = 'request_phone';

    await tgEditMessageText(
      chatId,
      messageId,
      `Name: ${fullName}\n\nNow please share your phone number:`
    );

    await tgSendMessage(chatId, 'Tap the button to share your phone:', {
      reply_markup: {
        keyboard: [
          [{ text: '📱 Share Phone Number', request_contact: true }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    return;
  }

  // name: manual
  if (data === 'name:manual') {
    session.step = 'wait_name_text';
    await tgEditMessageText(chatId, messageId, 'Okay, please type your name 👇');
    return;
  }

  // confirm order
  if (data === 'order:confirm') {
    await sendOrderToAdmin(session, from);
    // clear session for this customer
    sessions.set(chatId, {});
    await tgEditMessageText(
      chatId,
      messageId,
      '✅ Thank you! Your order was sent to the admin.',
      { reply_markup: restartInlineKeyboard() }
    );
    return;
  }

  // cancel
  if (data === 'order:cancel') {
    sessions.set(chatId, {});
    await tgEditMessageText(
      chatId,
      messageId,
      '❌ Order canceled. You can start again anytime.',
      { reply_markup: restartInlineKeyboard() }
    );
    return;
  }

  // restart
  if (data === 'order:restart') {
    sessions.set(chatId, { step: 'choose_amount' });
    await tgEditMessageText(
      chatId,
      messageId,
      '🧊 New order — please select an amount:',
      { reply_markup: amountInlineKeyboard() }
    );
    return;
  }
}

// ---------------------------------------------------------------------
// EXPRESS + WEBHOOK
// ---------------------------------------------------------------------

const app = express();
app.use(express.json());

// Telegram will POST updates here
const secretPath = `/telegraf/${BOT_TOKEN}`;

app.post(secretPath, async (req, res) => {
  const update = req.body;

  try {
    if (update.message) {
      const msg = update.message;
      if (msg.contact) {
        await handleContact(msg);
      } else if (msg.location) {
        await handleLocation(msg);
      } else {
        await handleMessage(msg);
      }
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (err) {
    console.error('Error handling update:', err);
  }

  // always answer Telegram fast
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('IceOrderBot (no Telegraf) is running ✅');
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  if (HOST_URL) {
    const webhookUrl = `${HOST_URL}${secretPath}`;
    try {
      const resp = await fetchFn(`${TELEGRAM_API}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl })
      });
      const data = await resp.json();
      console.log('✅ setWebhook response:', data);
    } catch (err) {
      console.error('❌ Failed to set webhook:', err);
    }
  } else {
    console.warn('⚠️ HOST_URL missing — set webhook manually.');
  }
});
