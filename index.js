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
  { command: "help", description: "Help info" },
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
    [{ text: "🛒 Add to cart", callback_data: "cart:add" }],
    [{ text: "🧾 View cart", callback_data: "cart:view" }],
    [{ text: "✅ Checkout", callback_data: "cart:checkout" }],
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
        [{ text: "1 G", callback_data: "amt:1 G" }],
        ...actions,
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
        ...actions,
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
    const r = await fetchFn(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "IceOrderBot/1.0" } }
    );
    const j = await r.json();
    return j.display_name || `${lat}, ${lon}`;
  } catch {
    return `${lat}, ${lon}`;
  }
}

// ───────── SEND ORDER TO ADMIN ─────────
async function sendOrderToAdmin(session, from) {
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" });
  const items = session.cart?.length
    ? session.cart.map((i) => `${i.category} — ${i.amount}`).join("\n")
    : `${session.category || "N/A"} — ${session.selectedAmount || "N/A"}`;
  const coords = session.coords
    ? `${session.coords.latitude}, ${session.coords.longitude}`
    : "N/A";
  const id = orderCounter++;

  orders.unshift({
    id,
    customerChatId: from.id,
    name: session.name,
    phone: session.phone,
    address: session.address,
    coords: session.coords,
    items: session.cart || [],
    createdAt: timestamp,
  });
  if (orders.length > 100) orders.pop();

  const text = `🧊 NEW ORDER #${id}

🧺 Items:
${items}

👤 ${session.name}
📱 ${session.phone}
📍 ${session.address}
🗺️ ${coords}

💰 Payment proof: ${session.paymentProof ? "✅ Received" : "❌ None"}
⏰ ${timestamp}`;

  const res = await tgSendMessage(ADMIN_CHAT_ID, text);
  const j = await res.json().catch(() => null);
  if (j?.ok)
    adminMessageMap.set(j.result.message_id, { customerChatId: from.id, orderId: id });

  if (session.coords)
    await tgSendLocation(ADMIN_CHAT_ID, session.coords.latitude, session.coords.longitude);

  if (session.paymentProof) {
    await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        photo: session.paymentProof,
        caption: `💰 GCash screenshot for order #${id}`,
      }),
    });
  }
}

// ───────── MESSAGE HANDLERS ─────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const s = getSession(chatId);

  if (!SHOP_OPEN && !ADMIN_IDS.includes(chatId)) {
    await tgSendMessage(chatId, "🏪 The shop is currently closed.\nPlease check back later!");
    return;
  }

  if (text === "/start" || text === "/restart") {
    sessions.set(chatId, { step: "choose_category", cart: [] });
    return tgSendMessage(chatId, "🧊 IceOrderBot\nChoose product type:", {
      reply_markup: buildAmountKeyboard({}),
    });
  }

  if (text === "/help")
    return tgSendMessage(chatId, "🆘 Use /start to begin ordering.");
  if (text === "/faq")
    return tgSendMessage(chatId, "❓ Pay via GCash then upload screenshot.");

  if (text === "/admin") {
    if (!ADMIN_IDS.includes(chatId)) return tgSendMessage(chatId, "🚫 Access denied.");
    loggedInAdmins.add(chatId);
    return tgSendMessage(chatId, "🧠 Admin Panel:", {
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
  const summary = `📋 *Order Summary*  

🧺 Items:  
${items}  

👤 ${s.name}  
📱 ${s.phone}  
📍 ${s.address}  

💰 *Payment Instructions:*  
Pay via *GCash 0927 896 8789* then tap *Payment Processed* and upload screenshot.`;
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
  if (!file) return tgSendMessage(chatId, "⚠️ Upload an image or PDF.");
  s.paymentProof = file;
  await sendOrderToAdmin(s, msg.from);
  sessions.set(chatId, {});
  await tgSendMessage(chatId, "✅ Payment received! Your order is processing.");
}

async function handleCallbackQuery(cbq) {
  const data = cbq.data;
  const chatId = cbq.message.chat.id;
  const msgId = cbq.message.message_id;
  const s = getSession(chatId);

  if (!SHOP_OPEN && !ADMIN_IDS.includes(chatId)) {
    await tgSendMessage(chatId, "🏪 Shop closed. Please check back later!");
    return;
  }

  // Admin actions
  if (data.startsWith("admin:")) {
    const act = data.split(":")[1];
    if (act === "toggle_shop") {
      SHOP_OPEN = !SHOP_OPEN;
      return tgSendMessage(
        chatId,
        SHOP_OPEN ? "🟢 Shop is now OPEN." : "🔴 Shop is now CLOSED."
      );
    }
    if (act === "logout") {
      loggedInAdmins.delete(chatId);
      return tgSendMessage(chatId, "🔐 Logged out.");
    }
    if (act === "view_orders") {
      if (!orders.length) return tgSendMessage(chatId, "🧾 No orders yet.");
      const list = orders
        .slice(0, 10)
        .map(
          (o) =>
            `#${o.id} ${o.name} — ${o.items.map((i) => i.amount).join(", ")}`
        )
        .join("\n");
      return tgSendMessage(chatId, `🧾 Recent Orders:\n${list}`);
    }
  }

  // User actions
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
    });
    await tgSendMessage(chatId, `🛒 Added: ${session.category} — ${session.selectedAmount}`);
    return;
  }

  if (data === "cart:view") {
    ensureCart(s);
    const txt = s.cart.length
      ? s.cart.map((x, i) => `${i + 1}. ${x.category} — ${x.amount}`).join("\n")
      : "🧺 Cart is empty.";
    return tgSendMessage(chatId, txt);
  }

  if (data === "cart:checkout") {
    ensureCart(s);
    if (!s.cart.length && s.category && s.selectedAmount)
      s.cart.push({ category: s.category, amount: s.selectedAmount });
    if (!s.cart.length) return tgSendMessage(chatId, "🧺 Cart empty.");
    s.step = "ask_name";
    return tgSendMessage(chatId, "📝 Enter your name:");
  }

  if (data === "order:confirm") {
    s.step = "await_payment_proof";
    return tgSendMessage(chatId, "📸 Please upload your GCash payment screenshot.");
  }

  if (data === "order:cancel") {
    sessions.set(chatId, {});
    return tgEditMessageText(chatId, msgId, "❌ Order canceled.");
  }
}

// ───────── EXPRESS WEBHOOK ─────────
const app = express();
app.use(express.json());

const path = `/telegraf/${BOT_TOKEN}`;

app.post(path, async (req, res) => {
  const u = req.body;
  try {
    if (u.message) {
      const m = u.message;
      if (m.contact) await handleContact(m);
      else if (m.location) await handleLocation(m);
      else if (m.photo || m.document) await handlePhotoOrDocument(m);
      else await handleMessage(m);
    } else if (u.callback_query) {
      await handleCallbackQuery(u.callback_query);
    }
  } catch (e) {
    console.error("Update error:", e);
  }
  res.sendStatus(200);
});

// Health endpoints
app.get("/", (_, res) => res.send("🧊 IceOrderBot running (webhook mode)."));
app.get("/ping", (_, res) => res.send("pong"));
app.get("/health", (_, res) =>
  res.json({ ok: true, shop_open: SHOP_OPEN, orders: orders.length })
);

// ───────── START SERVER ─────────
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await fetchFn(`${TELEGRAM_API}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: BOT_COMMANDS }),
  });
  if (HOST_URL) {
    const url = `${HOST_URL}${path}`;
    try {
      await fetchFn(`${TELEGRAM_API}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      console.log("✅ Webhook set to:", url);
    } catch (e) {
      console.error("Webhook error:", e);
    }
  }
});
