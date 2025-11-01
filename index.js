// index.js
import express from "express";
import fetchPkg from "node-fetch";

const fetchFn = typeof fetch !== "undefined" ? fetch : fetchPkg;

// ───────── CONFIG ─────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const HOST_URL = process.env.HOST_URL;
const PORT = process.env.PORT || 3000;

const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",").map((id) => Number(id.trim()))
  : [];

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing.");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const BOT_COMMANDS = [
  { command: "start", description: "Start new order" },
  { command: "restart", description: "Restart order" },
  { command: "help", description: "Help" },
  { command: "faq", description: "FAQ" },
  { command: "admin", description: "Admin control" },
];

// ───────── MEMORY STATE ─────────
const sessions = new Map();
const adminMessageMap = new Map();
const loggedInAdmins = new Set();
const orders = [];
let orderCounter = 1;
let SHOP_OPEN = true;

// ───────── HELPERS ─────────
function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId);
}
function ensureCart(session) {
  if (!session.cart) session.cart = [];
}
async function tgSendMessage(chatId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}
async function tgEditMessageText(chatId, messageId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...extra }),
  });
}
async function tgSendLocation(chatId, lat, lon) {
  return fetchFn(`${TELEGRAM_API}/sendLocation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, latitude: lat, longitude: lon }),
  });
}

function buildAmountKeyboard(session) {
  const cat = session.category;
  const actions = [
    { text: "🛒 Add to cart", callback_data: "cart:add" },
    { text: "🧾 View cart", callback_data: "cart:view" },
    { text: "✅ Checkout", callback_data: "cart:checkout" },
  ];
  if (cat === "sachet") {
    return {
      inline_keyboard: [
        [
          { text: "₱500", callback_data: "amt:₱500" },
          { text: "₱700", callback_data: "amt:₱700" },
        ],
        [
          { text: "₱1,000", callback_data: "amt:₱1,000" },
          { text: "Half G", callback_data: "amt:Half G" },
        ],
        [{ text: "1G", callback_data: "amt:1G" }],
        actions,
      ],
    };
  }
  if (cat === "syringe") {
    return {
      inline_keyboard: [
        [
          { text: "₱500", callback_data: "amt:₱500" },
          { text: "₱700", callback_data: "amt:₱700" },
        ],
        [{ text: "₱1,000", callback_data: "amt:₱1,000" }],
        actions,
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: "💧 Sachet", callback_data: "cat:sachet" },
        { text: "💉 Syringe", callback_data: "cat:syringe" },
      ],
    ],
  };
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetchFn(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "IceOrderBot/1.0" } }
    );
    const data = await res.json();
    return data.display_name || `${lat}, ${lon}`;
  } catch {
    return `${lat}, ${lon}`;
  }
}

async function sendOrderToAdmin(session, from) {
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" });
  const items = session.cart?.length
    ? session.cart.map((it) => `${it.category} — ${it.amount}`).join("\n")
    : `${session.category || "N/A"} — ${session.selectedAmount || "N/A"}`;
  const coords = session.coords
    ? `${session.coords.latitude}, ${session.coords.longitude}`
    : "N/A";
  const orderId = orderCounter++;

  orders.unshift({
    id: orderId,
    customerChatId: from.id,
    name: session.name,
    phone: session.phone,
    address: session.address,
    coords: session.coords,
    items: session.cart || [],
    createdAt: timestamp,
  });
  if (orders.length > 100) orders.pop();

  const text = `
🧊 NEW ORDER (#${orderId})

🧺 Items:
${items}

👤 ${session.name}
📱 ${session.phone}
📍 ${session.address}
🗺️ ${coords}

💰 Payment proof: ${session.paymentProof ? "✅ Received" : "❌ None"}
⏰ ${timestamp}
💡 Reply to this message to contact customer.
`.trim();

  const r = await tgSendMessage(ADMIN_CHAT_ID, text);
  const j = await r.json().catch(() => null);
  if (j?.ok)
    adminMessageMap.set(j.result.message_id, { customerChatId: from.id, orderId });

  if (session.coords)
    await tgSendLocation(ADMIN_CHAT_ID, session.coords.latitude, session.coords.longitude);

  if (session.paymentProof) {
    await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        photo: session.paymentProof,
        caption: `💰 GCash screenshot for order #${orderId}`,
      }),
    });
  }
}

// ───────── HANDLERS ─────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const from = msg.from;
  const text = msg.text || "";
  const s = getSession(chatId);

  // shop closed
  if (!SHOP_OPEN && !ADMIN_IDS.includes(chatId)) {
    await tgSendMessage(chatId, "🏪 Shop is currently *closed*.\nPlease check back later!", {
      parse_mode: "Markdown",
    });
    return;
  }

  // admin reply-to
  if (chatId === ADMIN_CHAT_ID && msg.reply_to_message) {
    const info = adminMessageMap.get(msg.reply_to_message.message_id);
    if (!info) return tgSendMessage(chatId, "⚠️ Cannot map reply.");
    await tgSendMessage(info.customerChatId, `🚚 Admin update (Order #${info.orderId}):\n${text}`);
    return tgSendMessage(chatId, "✅ Sent to customer.");
  }

  if (text === "/start" || text === "/restart") {
    sessions.set(chatId, { step: "choose_category", cart: [] });
    return tgSendMessage(chatId, "🧊 IceOrderBot\nChoose product type 👇", {
      reply_markup: buildAmountKeyboard({}),
    });
  }

  if (text === "/help")
    return tgSendMessage(chatId, "🆘 Use /start to begin.\nChoose, pay via GCash, upload proof, wait for admin.");
  if (text === "/faq")
    return tgSendMessage(chatId, "❓ Restart anytime with /restart.\nAdmin verifies GCash payments manually.");

  if (text === "/admin") {
    if (!ADMIN_IDS.includes(chatId)) return tgSendMessage(chatId, "🚫 Access denied.");
    loggedInAdmins.add(chatId);
    return tgSendMessage(chatId, "🧠 Admin Control Panel:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧾 View Orders", callback_data: "admin:view_orders" }],
          [{ text: "📢 Broadcast", callback_data: "admin:broadcast" }],
          [{ text: "📊 Analytics", callback_data: "admin:analytics" }],
          [
            {
              text: SHOP_OPEN ? "🔴 Close Shop" : "🟢 Open Shop",
              callback_data: "admin:toggle_shop",
            },
          ],
          [{ text: "🔐 Logout", callback_data: "admin:logout" }],
        ],
      },
    });
  }

  if (loggedInAdmins.has(chatId) && s.step === "await_broadcast") {
    const users = [...sessions.keys()].filter((id) => id !== ADMIN_CHAT_ID);
    for (const uid of users) await tgSendMessage(uid, `📢 Announcement:\n${text}`);
    s.step = null;
    return tgSendMessage(chatId, `✅ Broadcast sent to ${users.length} users.`);
  }

  if (s.step === "ask_name") {
    s.name = text.trim();
    s.step = "request_phone";
    return tgSendMessage(chatId, "📱 Share your phone number:", {
      reply_markup: {
        keyboard: [[{ text: "📱 Share Phone", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }

  if (s.step === "await_payment_proof")
    return tgSendMessage(chatId, "📸 Please upload your GCash screenshot.");

  return tgSendMessage(chatId, "Please /start to begin.");
}

async function handleContact(msg) {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (s.step !== "request_phone") return;
  s.phone = msg.contact.phone_number;
  s.step = "request_location";
  await tgSendMessage(chatId, "📍 Send your delivery location:", {
    reply_markup: {
      keyboard: [[{ text: "📍 Share Location", request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function handleLocation(msg) {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (s.step !== "request_location") return;

  const { latitude, longitude } = msg.location;
  s.coords = { latitude, longitude };
  s.address = await reverseGeocode(latitude, longitude);
  s.step = "confirm";

  const items = s.cart?.length
    ? s.cart.map((it, i) => `${i + 1}. ${it.category} — ${it.amount}`).join("\n")
    : `${s.category || "N/A"} — ${s.selectedAmount || "N/A"}`;

  const summary = `
📋 *Order Summary*

🧺 Items:
${items}

👤 ${s.name}
📱 ${s.phone}
📍 ${s.address}

💰 *Payment Instructions:*
Pay via *GCash 0927 896 8789* then tap *Payment Processed* and upload screenshot.
`.trim();

  await tgSendMessage(chatId, summary, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💰 Payment Processed", callback_data: "order:confirm" }],
        [{ text: "❌ Cancel", callback_data: "order:cancel" }],
      ],
    },
  });
}

async function handlePhotoOrDocument(msg) {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (s.step !== "await_payment_proof") return;
  const file = msg.photo ? msg.photo.pop().file_id : msg.document?.file_id;
  if (!file) return tgSendMessage(chatId, "⚠️ Upload image or PDF.");
  s.paymentProof = file;
  await sendOrderToAdmin(s, msg.from);
  sessions.set(chatId, {});
  await tgSendMessage(chatId, "✅ Payment received! Order processing.");
}

async function handleCallbackQuery(cbq) {
  const data = cbq.data;
  const chatId = cbq.message.chat.id;
  const msgId = cbq.message.message_id;
  const from = cbq.from;
  const s = getSession(chatId);

  if (!SHOP_OPEN && !ADMIN_IDS.includes(chatId)) {
    await tgSendMessage(chatId, "🏪 Shop closed. Please check back later!");
    return;
  }

  // ── ADMIN ──
  if (data.startsWith("admin:")) {
    if (!ADMIN_IDS.includes(chatId) || !loggedInAdmins.has(chatId))
      return tgSendMessage(chatId, "🚫 Unauthorized.");
    const action = data.split(":")[1];
    if (action === "toggle_shop") {
      SHOP_OPEN = !SHOP_OPEN;
      return tgSendMessage(
        chatId,
        SHOP_OPEN ? "🟢 Shop is now OPEN." : "🔴 Shop is now CLOSED.",
        { parse_mode: "Markdown" }
      );
    }
    if (action === "view_orders") {
      if (!orders.length) return tgSendMessage(chatId, "🧾 No orders yet.");
      const list = orders
        .slice(0, 10)
        .map(
          (o) =>
            `#${o.id} ${o.name} — ${o.items.map((i) => i.amount).join(", ")} (${o.createdAt})`
        )
        .join("\n");
      return tgSendMessage(chatId, `🧾 Recent Orders:\n${list}`);
    }
    if (action === "broadcast") {
      s.step = "await_broadcast";
      return tgSendMessage(chatId, "📢 Send message to broadcast.");
    }
    if (action === "analytics") {
      const total = orders.length;
      const freq = {};
      for (const o of orders)
        for (const it of o.items) freq[it.category] = (freq[it.category] || 0) + 1;
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
      return tgSendMessage(
        chatId,
        `📊 Total orders: ${total}\nTop: ${top ? `${top[0]} (${top[1]})` : "N/A"}`
      );
    }
    if (action === "logout") {
      loggedInAdmins.delete(chatId);
      return tgSendMessage(chatId, "🔐 Logged out.");
    }
  }

  // ── USER ──
  if (data.startsWith("cat:")) {
    s.category = data.slice(4);
    s.step = "choose_amount";
    ensureCart(s);
    return tgEditMessageText(chatId, msgId, `🧊 ${s.category} selected.`, {
      reply_markup: buildAmountKeyboard(s),
    });
  }

  if (data.startsWith("amt:")) {
    s.selectedAmount = data.slice(4);
    return tgEditMessageText(chatId, msgId, `💸 Selected ${s.selectedAmount}`, {
      reply_markup: buildAmountKeyboard(s),
    });
  }

  // ✅ FIXED CART ADD
  if (data === "cart:add") {
    const session = getSession(chatId);
    ensureCart(session);
    if (!session.category || !session.selectedAmount) {
      await tgSendMessage(chatId, "⚠️ Select category and amount first.");
      return;
    }
    session.cart.push({
      category: session.category,
      amount: session.selectedAmount,
      addedAt: Date.now(),
    });
    console.log("Cart updated:", session.cart);
    await tgSendMessage(chatId, `🛒 Added: ${session.category} — ${session.selectedAmount}`);
    await tgSendMessage(chatId, "You can add more, view cart, or checkout 👇", {
      reply_markup: buildAmountKeyboard(session),
    });
    return;
  }

  if (data === "cart:view") {
    ensureCart(s);
    const text = s.cart.length
      ? s.cart.map((x, i) => `${i + 1}. ${x.category} — ${x.amount}`).join("\n")
      : "🧺 Cart is empty.";
    return tgSendMessage(chatId, text);
  }

  if (data === "cart:checkout") {
    ensureCart(s);
    if (!s.cart.length && s.category && s.selectedAmount)
