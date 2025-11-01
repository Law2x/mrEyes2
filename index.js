// index.js
import express from 'express';
import fetchPkg from 'node-fetch';

// use global fetch if available (Node 18+), else use node-fetch
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

// chatId -> session
const sessions = new Map();

// adminMessageId -> { customerChatId, orderId }
const adminMessageMap = new Map();

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

function ensureCart(session) {
  if (!session.cart) {
    session.cart = [];
  }
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

// build product keyboard based on category + add/view/checkout
function buildAmountKeyboard(session) {
  const cat = session.category;

  const actionRow = [
    { text: '🛒 Add to cart', callback_data: 'cart:add' },
    { text: '🧾 View cart', callback_data: 'cart:view' },
    { text: '✅ Checkout', callback_data: 'cart:checkout' }
  ];

  // SACHET: full list
  if (cat === 'sachet') {
    return {
      inline_keyboard: [
        [
          { text: '₱500', callback_data: 'amt:₱500' },
          { text: '₱700', callback_data: 'amt:₱700' }
        ],
        [
          { text: '₱1,000', callback_data: 'amt:₱1,000' },
          { text: 'Half G', callback_data: 'amt:Half G' }
        ],
        [
          { text: '1G', callback_data: 'amt:1G' }
        ],
        actionRow
      ]
    };
  }

  // SYRINGE: only 500, 700, 1,000
  if (cat === 'syringe') {
    return {
      inline_keyboard: [
        [
          { text: '₱500', callback_data: 'amt:₱500' },
          { text: '₱700', callback_data: 'amt:₱700' }
        ],
        [
          { text: '₱1,000', callback_data: 'amt:₱1,000' }
        ],
        actionRow
      ]
    };
  }

  // fallback (no category yet)
  return {
    inline_keyboard: [
      [
        { text: '💧 Sachet', callback_data: 'cat:sachet' },
        { text: '💉 Syringe', callback_data: 'cat:syringe' }
      ]
    ]
  };
}

// reverse geocode for nicer address
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

// send to admin and remember mapping
async function sendOrderToAdmin(session, from) {
  if (!ADMIN_CHAT_ID || Number.isNaN(ADMIN_CHAT_ID)) {
    console.error('ADMIN_CHAT_ID not configured, skipping admin send.');
    return;
  }

  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Manila'
  });

  // build items text (from cart if present)
  let itemsText = '';
  if (session.cart && session.cart.length) {
    itemsText = session.cart
      .map(
        (item, idx) => `${idx + 1}. ${item.category} — ${item.amount}`
      )
      .join('\n');
  } else {
    itemsText = `${session.category || 'N/A'} — ${session.amount || 'N/A'}`;
  }

  const coordsText = session.coords
    ? `${session.coords.latitude}, ${session.coords.longitude}`
    : 'N/A';

  const orderId = orderCounter++;

  const adminText = `
🧊 NEW ORDER (#${orderId})

🧺 Items:
${itemsText}

👤 Name: ${session.name || 'N/A'}
📱 Phone: ${session.phone || 'N/A'}
📍 Address: ${session.address || 'N/A'}
🗺️ Coords: ${coordsText}

💡 Reply to THIS message to send tracking to this customer.
⏰ ${timestamp}
  `.trim();

  const resp = await tgSendMessage(ADMIN_CHAT_ID, adminText);
  const data = await resp.json().catch(() => null);

  if (data && data.ok) {
    const adminMessageId = data.result.message_id;
    adminMessageMap.set(adminMessageId, {
      customerChatId: from.id,
      orderId
    });
  }

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

async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from;
  const text = message.text || '';
  const session = getSession(chatId);

  // 1) ADMIN replied to an order (swipe-to-reply)
  if (chatId === ADMIN_CHAT_ID && message.reply_to_message) {
    const repliedMsgId = message.reply_to_message.message_id;
    const info = adminMessageMap.get(repliedMsgId);

    if (!info) {
      await tgSendMessage(chatId, 'I don’t know which customer this belongs to.');
      return;
    }

    await tgSendMessage(
      info.customerChatId,
      `🚚 Update for your order #${info.orderId}:\n${text}`
    );

    await tgSendMessage(
      chatId,
      `✅ Sent to customer of order #${info.orderId}`
    );
    return;
  }

  // 2) /start
  if (text === '/start') {
    sessions.set(chatId, { step: 'choose_category', cart: [] });
    await tgSendMessage(
      chatId,
      '🧊 *IceOrderBot*\nChoose product type 👇',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💧 Sachet', callback_data: 'cat:sachet' },
              { text: '💉 Syringe', callback_data: 'cat:syringe' }
            ]
          ]
        }
      }
    );
    return;
  }

  // 3) user typed name (after checkout)
  if (session.step === 'ask_name') {
    session.name = text.trim();
    session.step = 'request_phone';

    await tgSendMessage(
      chatId,
      '📱 Please share your phone number:',
      {
        reply_markup: {
          keyboard: [
            [{ text: '📱 Share Phone Number', request_contact: true }]
          ],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
    return;
  }

  // 4) user typed something while we want confirm
  if (session.step === 'confirm') {
    await tgSendMessage(chatId, 'Please tap ✅ Confirm or ❌ Cancel above.');
    return;
  }

  // fallback
  await tgSendMessage(chatId, 'Please /start to begin.');
}

async function handleContact(message) {
  const chatId = message.chat.id;
  const session = getSession(chatId);
  if (session.step !== 'request_phone') return;

  const phone = message.contact?.phone_number;
  if (!phone) {
    await tgSendMessage(chatId, '❗ No phone number received. Try again.');
    return;
  }

  session.phone = phone;
  session.step = 'request_location';

  await tgSendMessage(
    chatId,
    '📍 **Step 4/4**\nSend your delivery location.\nTip: tap the button below 👇',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '📍 Share Location', request_location: true }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    }
  );
}

async function handleLocation(message) {
  const chatId = message.chat.id;
  const session = getSession(chatId);
  if (session.step !== 'request_location') return;

  const loc = message.location;
  if (!loc) {
    await tgSendMessage(chatId, '❗ Location not received, please try again.');
    return;
  }

  const { latitude, longitude } = loc;
  session.coords = { latitude, longitude };

  const address = await reverseGeocode(latitude, longitude);
  session.address = address;
  session.step = 'confirm';

  const itemsText = (session.cart && session.cart.length)
    ? session.cart.map((it, i) => `${i + 1}. ${it.category} — ${it.amount}`).join('\n')
    : `${session.category || 'N/A'} — ${session.amount || 'N/A'}`;

  const summary = `
📋 *Order Summary*

🧺 Items:
${itemsText}

👤 Name: ${session.name || 'N/A'}
📱 Phone: ${session.phone || 'N/A'}

📍 Address:
${address}

Please confirm 👇
  `.trim();

  // send summary with confirm/cancel
  await tgSendMessage(chatId, summary, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: 'order:confirm' },
          { text: '❌ Cancel', callback_data: 'order:cancel' }
        ]
      ]
    }
  });

  // remove big keyboard
  await tgSendMessage(chatId, ' ', {
    reply_markup: { remove_keyboard: true }
  });
}

async function handleCallbackQuery(cbq) {
  const data = cbq.data;
  const message = cbq.message;
  const from = cbq.from;
  const chatId = message.chat.id;
  const messageId = message.message_id;

  const session = getSession(chatId);

  // 1) category selected
  if (data.startsWith('cat:')) {
    const category = data.slice(4); // sachet | syringe
    session.category = category;
    session.step = 'choose_amount';
    ensureCart(session);

    await tgEditMessageText(
      chatId,
      messageId,
      `🧊 ${category === 'sachet' ? 'Sachet' : 'Syringe'} selected.\nNow choose amount or add to cart 👇`,
      {
        reply_markup: buildAmountKeyboard(session)
      }
    );
    return;
  }

  // 2) amount selected
  if (data.startsWith('amt:')) {
    const amount = data.slice(4);
    session.selectedAmount = amount;

    await tgEditMessageText(
      chatId,
      messageId,
      `🧊 ${session.category === 'syringe' ? 'Syringe' : 'Sachet'} selected.\n💸 Amount: ${amount}\nYou can add to cart, view cart, or checkout 👇`,
      {
        reply_markup: buildAmountKeyboard(session)
      }
    );
    return;
  }

  // 3) add to cart
  if (data === 'cart:add') {
    ensureCart(session);
    if (!session.category || !session.selectedAmount) {
      await tgSendMessage(chatId, '⚠️ Please pick a category and amount first.');
      return;
    }

    session.cart.push({
      category: session.category,
      amount: session.selectedAmount,
      addedAt: Date.now()
    });

    await tgSendMessage(
      chatId,
      `🛒 Added: ${session.category} — ${session.selectedAmount}`
    );

    await tgSendMessage(
      chatId,
      'You can add more, view cart, or checkout 👇',
      {
        reply_markup: buildAmountKeyboard(session)
      }
    );
    return;
  }

  // 4) view cart
  if (data === 'cart:view') {
    ensureCart(session);
    if (!session.cart.length) {
      await tgSendMessage(chatId, '🧺 Cart is empty.');
    } else {
      const lines = session.cart.map((item, idx) => (
        `${idx + 1}. ${item.category} — ${item.amount}`
      ));
      await tgSendMessage(
        chatId,
        `🧾 *Your cart:*\n${lines.join('\n')}`,
        { parse_mode: 'Markdown' }
      );
    }

    await tgSendMessage(
      chatId,
      'Continue selecting or checkout 👇',
      {
        reply_markup: buildAmountKeyboard(session)
      }
    );
    return;
  }

  // 5) checkout
  if (data === 'cart:checkout') {
    ensureCart(session);
    if (!session.cart.length && (!session.category || !session.selectedAmount)) {
      await tgSendMessage(chatId, '🧺 Cart is empty. Add at least 1 item.');
      return;
    }

    // if no cart but user picked one item, add it automatically
    if (!session.cart.length && session.category && session.selectedAmount) {
      session.cart.push({
        category: session.category,
        amount: session.selectedAmount,
        addedAt: Date.now()
      });
    }

    session.step = 'ask_name';
    await tgSendMessage(chatId, '📝 Please enter your name:');
    return;
  }

  // 6) confirm final order
  if (data === 'order:confirm') {
    await sendOrderToAdmin(session, from);
    // clear session
    sessions.set(chatId, {});
    await tgEditMessageText(
      chatId,
      messageId,
      '✅ Thank you! Your order was sent to the admin.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔁 New Order', callback_data: 'start:new' }]
          ]
        }
      }
    );
    return;
  }

  // 7) cancel final order
  if (data === 'order:cancel') {
    sessions.set(chatId, {});
    await tgEditMessageText(
      chatId,
      messageId,
      '❌ Order canceled. You can /start again.'
    );
    return;
  }

  // 8) restart
  if (data === 'start:new') {
    sessions.set(chatId, { step: 'choose_category', cart: [] });
    await tgEditMessageText(
      chatId,
      messageId,
      '🧊 *IceOrderBot*\nChoose product type 👇',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💧 Sachet', callback_data: 'cat:sachet' },
              { text: '💉 Syringe', callback_data: 'cat:syringe' }
            ]
          ]
        }
      }
    );
    return;
  }
}

// ---------------------------------------------------------------------
// EXPRESS + WEBHOOK
// ---------------------------------------------------------------------

const app = express();
app.use(express.json());

// Telegram will POST here
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
