// index.js
import express from 'express';
import fetchPkg from 'node-fetch';

// use global fetch if available (Node 18+), else node-fetch
const fetchFn = (typeof fetch !== 'undefined') ? fetch : fetchPkg;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const HOST_URL = process.env.HOST_URL; // e.g. https://your-app.onrender.com
const PORT = process.env.PORT || 3000;

// admin ids: comma separated, e.g. "12345,67890"
const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(',').map((id) => Number(id.trim()))
  : [];

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required');
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// commands that will show up on Telegram’s menu button
const BOT_COMMANDS = [
  { command: 'start', description: 'Start new order' },
  { command: 'restart', description: 'Restart the order process' },
  { command: 'help', description: 'How to use the bot' },
  { command: 'faq', description: 'Frequently asked questions' },
  { command: 'admin', description: 'Admin control (restricted)' }
];

// ---------------------------------------------------------------------
// IN-MEMORY STATE
// ---------------------------------------------------------------------

// per-customer session: chatId -> session
const sessions = new Map();

// admin message map: adminMessageId -> { customerChatId, orderId }
const adminMessageMap = new Map();

// all orders (memory only)
const orders = []; // { id, customerChatId, items, name, phone, address, coords, createdAt }

// logged-in admins (chat ids)
const loggedInAdmins = new Set();

// auto-increment order id
let orderCounter = 1;

// ---------------------------------------------------------------------
// HELPERS
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

// universal send
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

// build product keyboard based on chosen category
function buildAmountKeyboard(session) {
  const cat = session.category;

  // persistent action row
  const actionRow = [
    { text: '🛒 Add to cart', callback_data: 'cart:add' },
    { text: '🧾 View cart', callback_data: 'cart:view' },
    { text: '✅ Checkout', callback_data: 'cart:checkout' }
  ];

  // SACHET → full list
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

  // SYRINGE → only 500 / 700 / 1,000
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

  // no category yet
  return {
    inline_keyboard: [
      [
        { text: '💧 Sachet', callback_data: 'cat:sachet' },
        { text: '💉 Syringe', callback_data: 'cat:syringe' }
      ]
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

// save order to memory + send to admin
async function sendOrderToAdmin(session, from) {
  if (!ADMIN_CHAT_ID || Number.isNaN(ADMIN_CHAT_ID)) {
    console.error('ADMIN_CHAT_ID not configured, skipping admin send.');
  }

  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Manila'
  });

  // build items text
  let itemsText = '';
  let itemsArray = [];

  if (session.cart && session.cart.length) {
    itemsArray = session.cart.map((it) => ({
      category: it.category,
      amount: it.amount
    }));
    itemsText = session.cart
      .map((it, idx) => `${idx + 1}. ${it.category} — ${it.amount}`)
      .join('\n');
  } else {
    itemsArray = [
      {
        category: session.category || 'N/A',
        amount: session.amount || session.selectedAmount || 'N/A'
      }
    ];
    itemsText = `${session.category || 'N/A'} — ${session.amount || session.selectedAmount || 'N/A'}`;
  }

  const coordsText = session.coords
    ? `${session.coords.latitude}, ${session.coords.longitude}`
    : 'N/A';

  const orderId = orderCounter++;

  // save to memory
  orders.unshift({
    id: orderId,
    customerChatId: from.id,
    name: session.name || 'N/A',
    phone: session.phone || 'N/A',
    address: session.address || 'N/A',
    coords: session.coords || null,
    items: itemsArray,
    createdAt: timestamp
  });

  // keep most recent 100 to avoid growth
  if (orders.length > 100) {
    orders.pop();
  }

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

  if (ADMIN_CHAT_ID && !Number.isNaN(ADMIN_CHAT_ID)) {
    const resp = await tgSendMessage(ADMIN_CHAT_ID, adminText);
    const data = await resp.json().catch(() => null);
    if (data && data.ok) {
      const adminMessageId = data.result.message_id;
      adminMessageMap.set(adminMessageId, {
        customerChatId: from.id,
        orderId
      });
    }

    // also send location
    if (session.coords) {
      await tgSendLocation(
        ADMIN_CHAT_ID,
        session.coords.latitude,
        session.coords.longitude
      );
    }
  }
}

// ---------------------------------------------------------------------
// MESSAGE HANDLERS
// ---------------------------------------------------------------------

async function handleMessage(message) {
  const chatId = message.chat.id;
  const from = message.from;
  const text = message.text || '';
  const session = getSession(chatId);

  // 0) admin reply-to-order (swipe-to-reply)
  if (chatId === ADMIN_CHAT_ID && message.reply_to_message) {
    const repliedMsgId = message.reply_to_message.message_id;
    const info = adminMessageMap.get(repliedMsgId);
    if (!info) {
      await tgSendMessage(chatId, '⚠️ I cannot map this reply to a customer.');
      return;
    }
    await tgSendMessage(
      info.customerChatId,
      `🚚 Update for your order #${info.orderId}:\n${text}`
    );
    await tgSendMessage(chatId, `✅ Sent to customer of order #${info.orderId}`);
    return;
  }

  // /restart
  if (text === '/restart') {
    sessions.set(chatId, { step: 'choose_category', cart: [] });
    await tgSendMessage(
      chatId,
      '🔁 Order restarted.\nChoose product type 👇',
      {
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

  // /help
  if (text === '/help') {
    await tgSendMessage(
      chatId,
      `🆘 *How to use the bot*\n\n1) /start → choose product\n2) pick amount → add to cart / checkout\n3) send name, phone, location\n4) confirm ✅`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // /faq
  if (text === '/faq') {
    await tgSendMessage(
      chatId,
      `❓ *FAQ*\n\n• You can /restart anytime.\n• Admin will send you tracking by replying to your order.\n• Location is only sent to admin.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // /admin (login)
  if (text === '/admin') {
    if (!ADMIN_IDS.includes(chatId)) {
      await tgSendMessage(chatId, '🚫 Access denied.');
      return;
    }

    loggedInAdmins.add(chatId);

    await tgSendMessage(
      chatId,
      '🧠 *Admin Control Panel*\nChoose an action:',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🧾 View Orders', callback_data: 'admin:view_orders' }],
            [{ text: '📢 Broadcast', callback_data: 'admin:broadcast' }],
            [{ text: '📊 Analytics', callback_data: 'admin:analytics' }],
            [{ text: '🔐 Logout', callback_data: 'admin:logout' }]
          ]
        }
      }
    );
    return;
  }

  // admin broadcast message (step)
  if (loggedInAdmins.has(chatId)) {
    if (session.step === 'await_broadcast') {
      // collect customers
      const allCustomers = Array.from(sessions.keys()).filter(
        (id) => id !== ADMIN_CHAT_ID
      );
      for (const userId of allCustomers) {
        await tgSendMessage(
          userId,
          `📢 *Announcement:*\n${text}`,
          { parse_mode: 'Markdown' }
        );
      }
      session.step = null;
      await tgSendMessage(
        chatId,
        `✅ Broadcast sent to ${allCustomers.length} chats.`
      );
      return;
    }
  }

  // /start
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

  // user typing name (after checkout)
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

  // user typed while waiting for confirm
  if (session.step === 'confirm') {
    await tgSendMessage(chatId, 'Please tap ✅ Confirm or ❌ Cancel.');
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
    await tgSendMessage(chatId, '❗ No phone received. Try again.');
    return;
  }

  session.phone = phone;
  session.step = 'request_location';

  await tgSendMessage(
    chatId,
    '📍 **Step 4/4**\nSend your delivery location.\nTap the button below 👇',
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
    await tgSendMessage(chatId, '❗ Location not received. Try again.');
    return;
  }

  const { latitude, longitude } = loc;
  session.coords = { latitude, longitude };

  const address = await reverseGeocode(latitude, longitude);
  session.address = address;
  session.step = 'confirm';

  const itemsText = (session.cart && session.cart.length)
    ? session.cart.map((it, i) => `${i + 1}. ${it.category} — ${it.amount}`).join('\n')
    : `${session.category || 'N/A'} — ${session.amount || session.selectedAmount || 'N/A'}`;

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

  // remove reply keyboard
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

  // ADMIN ACTIONS -----------------------------------------------------
  if (data.startsWith('admin:')) {
    // must be allowed and logged in
    if (!ADMIN_IDS.includes(chatId) || !loggedInAdmins.has(chatId)) {
      await tgSendMessage(chatId, '🚫 Unauthorized.');
      return;
    }

    const action = data.split(':')[1];

    // view orders
    if (action === 'view_orders') {
      if (!orders.length) {
        await tgSendMessage(chatId, '🧾 No orders yet.');
        return;
      }

      const recent = orders.slice(0, 10);
      const lines = recent.map((o) => {
        const items = o.items.map((it) => `${it.category} — ${it.amount}`).join(', ');
        return `#${o.id} — ${o.name} — ${items} — ${o.createdAt}`;
      });

      await tgSendMessage(
        chatId,
        '🧾 *Recent Orders:*\n' + lines.join('\n'),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // broadcast
    if (action === 'broadcast') {
      session.step = 'await_broadcast';
      await tgSendMessage(chatId, '📢 Send the message to broadcast to all customers.');
      return;
    }

    // analytics (simple, since memory-only)
    if (action === 'analytics') {
      const total = orders.length;
      // count per category
      const counts = {};
      for (const o of orders) {
        for (const it of o.items) {
          const key = it.category;
          counts[key] = (counts[key] || 0) + 1;
        }
      }
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      const bestText = best ? `${best[0]} (${best[1]})` : 'N/A';

      await tgSendMessage(
        chatId,
        `📊 *Analytics*\nTotal orders: ${total}\nTop item: ${bestText}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // logout
    if (action === 'logout') {
      loggedInAdmins.delete(chatId);
      await tgSendMessage(chatId, '🔐 Admin logged out.');
      return;
    }
  }

  // CUSTOMER ACTIONS --------------------------------------------------

  // category selected
  if (data.startsWith('cat:')) {
    const category = data.slice(4); // sachet | syringe
    session.category = category;
    session.step = 'choose_amount';
    ensureCart(session);

    await tgEditMessageText(
      chatId,
      messageId,
      `🧊 ${category === 'sachet' ? 'Sachet' : 'Syringe'} selected.\nChoose amount or use cart 👇`,
      {
        reply_markup: buildAmountKeyboard(session)
      }
    );
    return;
  }

  // amount selected
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

  // add to cart
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

  // view cart
  if (data === 'cart:view') {
    ensureCart(session);
    if (!session.cart.length) {
      await tgSendMessage(chatId, '🧺 Cart is empty.');
    } else {
      const lines = session.cart.map(
        (item, idx) => `${idx + 1}. ${item.category} — ${item.amount}`
      );
      await tgSendMessage(
        chatId,
        `🧾 *Your cart:*\n${lines.join('\n')}`,
        { parse_mode: 'Markdown' }
      );
    }

    await tgSendMessage(chatId, 'Continue selecting or checkout 👇', {
      reply_markup: buildAmountKeyboard(session)
    });
    return;
  }

  // checkout
  if (data === 'cart:checkout') {
    ensureCart(session);

    // if cart empty but user picked single item, auto-add it
    if (!session.cart.length && session.category && session.selectedAmount) {
      session.cart.push({
        category: session.category,
        amount: session.selectedAmount,
        addedAt: Date.now()
      });
    }

    if (!session.cart.length) {
      await tgSendMessage(chatId, '🧺 Cart is empty. Add at least 1 item.');
      return;
    }

    session.step = 'ask_name';
    await tgSendMessage(chatId, '📝 Please enter your name:');
    return;
  }

  // confirm final order
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

  // cancel final order
  if (data === 'order:cancel') {
    sessions.set(chatId, {});
    await tgEditMessageText(
      chatId,
      messageId,
      '❌ Order canceled. You can /start again.'
    );
    return;
  }

  // restart
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

// telegram webhook path
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

// health endpoints (for ping / uptime robot)
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), orders: orders.length });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

app.get('/', (req, res) => {
  res.send('IceOrderBot (no Telegraf) is running ✅');
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // set menu commands
  try {
    const resp = await fetchFn(`${TELEGRAM_API}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: BOT_COMMANDS })
    });
    const data = await resp.json();
    console.log('✅ Menu commands set:', data);
  } catch (err) {
    console.error('⚠️ Failed to set commands:', err);
  }

  // set webhook
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
