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
  { command: "contact", description: "Connect to admin" }
];

// ───────── MEMORY STATE ─────────
const sessions = new Map();
const adminMessageMap = new Map(); // admin message_id -> { customerChatId, orderId? }
const loggedInAdmins = new Set();
const orders = [];
let orderCounter = 1;
let SHOP_OPEN = true;

// ───────── EXPRESS APP ─────────
const app = express();
app.use(express.json());
app.use("/static", express.static("public")); // QR at /static/qrph.jpg

// ───────── HELPERS ─────────
function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId);
}
function ensureCart(s) {
  if (!s.cart) s.cart = [];
}

async function tgSendMessage(chatId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}
async function tgEditMessageText(chatId, msgId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: msgId, text, ...extra }),
  });
}
async function tgSendLocation(chatId, lat, lon) {
  return fetchFn(`${TELEGRAM_API}/sendLocation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, latitude: lat, longitude: lon }),
  });
}

// Build keyboards with persistent "Connect to Admin"
function addSupportRow(kb) {
  const supportRow = [{ text: "🧑‍💼 Connect to Admin", callback_data: "support:connect" }];
  return { inline_keyboard: [...kb.inline_keyboard, supportRow] };
}

function buildAmountKeyboard(session) {
  const cat = session.category;
  const base = [
    [{ text: "🛒 Add to cart", callback_data: "cart:add" }],
    [{ text: "🧾 View cart", callback_data: "cart:view" }],
    [{ text: "✅ Checkout", callback_data: "cart:checkout" }],
  ];
  if (cat === "sachet") {
    return addSupportRow({
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
        ...base,
      ],
    });
  }
  if (cat === "syringe") {
    return addSupportRow({
      inline_keyboard: [
        [
          { text: "₱500", callback_data: "amt:₱500" },
          { text: "₱700", callback_data: "amt:₱700" },
        ],
        [{ text: "₱1,000", callback_data: "amt:₱1,000" }],
        ...base,
      ],
    });
  }
  return addSupportRow({
    inline_keyboard: [
      [
        { text: "💧 Sachet", callback_data: "cat:sachet" },
        { text: "💉 Syringe", callback_data: "cat:syringe" },
      ],
    ],
  });
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

// ───────── ADMIN NOTIFICATION ─────────
async function sendOrderToAdmin(s, from) {
  const ts = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" });
  const items = s.cart?.length
    ? s.cart.map((i) => `${i.category} — ${i.amount}`).join("\n")
    : `${s.category || "N/A"} — ${s.selectedAmount || "N/A"}`;
  const coords = s.coords ? `${s.coords.latitude}, ${s.coords.longitude}` : "N/A";
  const id = orderCounter++;

  orders.unshift({
    id,
    customerChatId: from.id,
    name: s.name,
    phone: s.phone,
    address: s.address,
    coords: s.coords,
    items: s.cart || [],
    createdAt: ts,
  });
  if (orders.length > 100) orders.pop();

  const text = `
🧊 NEW ORDER (#${id})

🧺 Items:
${items}

👤 ${s.name}
📱 ${s.phone}
📍 ${s.address}
🗺️ ${coords}

💰 Payment proof: ${s.paymentProof ? "✅ Received" : "❌ None"}
⏰ ${ts}

🛵 *Note:* Customer was informed that a Grab delivery link will be generated and sent shortly.
`.trim();

  const r = await tgSendMessage(ADMIN_CHAT_ID, text);
  const j = await r.json().catch(() => null);
  if (j?.ok) adminMessageMap.set(j.result.message_id, { customerChatId: from.id });

  if (s.coords)
    await tgSendLocation(ADMIN_CHAT_ID, s.coords.latitude, s.coords.longitude);

  if (s.paymentProof) {
    await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        photo: s.paymentProof,
        caption: `💰 GCash/QRPh screenshot for order #${id}`,
      }),
    });
  }
}

// ───────── HANDLERS ─────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const s = getSession(chatId);

  if (!SHOP_OPEN && !ADMIN_IDS.includes(chatId)) {
    await tgSendMessage(chatId, "🏪 The shop is currently closed.\nPlease check back later!");
    return;
  }

  // admin replies to forwarded messages
  if (chatId === ADMIN_CHAT_ID && msg.reply_to_message) {
    const info = adminMessageMap.get(msg.reply_to_message.message_id);
    if (!info) return tgSendMessage(chatId, "⚠️ Cannot map reply.");
    await tgSendMessage(info.customerChatId, `🧑‍💼 Admin:\n${text}`);
    return tgSendMessage(chatId, "✅ Sent to customer.");
  }

  // commands
  if (text === "/start" || text === "/restart") {
    sessions.set(chatId, { step: "choose_category", cart: [] });
    return tgSendMessage(chatId, "🧊 IceOrderBot\nChoose product type 👇", {
      reply_markup: buildAmountKeyboard({}),
    });
  }

  if (text === "/help")
    return tgSendMessage(chatId, "🆘 Use /start to begin your order.\nUse the *Connect to Admin* button anytime.", { parse_mode: "Markdown" });

  if (text === "/faq")
    return tgSendMessage(chatId, "❓ Pay via QRPh / GCash, then upload screenshot. Admin will confirm.");

  if (text === "/admin") {
    if (!ADMIN_IDS.includes(chatId)) return tgSendMessage(chatId, "🚫 Access denied.");
    loggedInAdmins.add(chatId);
    return tgSendMessage(chatId, "🧠 Admin Control Panel:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧾 View Orders", callback_data: "admin:view_orders" }],
          [{ text: "📢 Broadcast", callback_data: "admin:broadcast" }],
          [{ text: "📊 Analytics", callback_data: "admin:analytics" }],
          [{ text: SHOP_OPEN ? "🔴 Close Shop" : "🟢 Open Shop", callback_data: "admin:toggle_shop" }],
          [{ text: "🔐 Logout", callback_data: "admin:logout" }],
        ],
      },
    });
  }

  if (text === "/contact") {
    s.prevStep = s.step || null;
    s.step = "support_wait_message";
    return tgSendMessage(chatId, "🧑‍💼 Please type your message for the admin:");
  }

  // support message flow
  if (s.step === "support_wait_message" && text) {
    const supportText = `🆘 *Support Request*\n\nFrom: ${msg.from.first_name || "Customer"} (ID: ${msg.from.id})\nUsername: ${msg.from.username ? "@" + msg.from.username : "N/A"}\n\nMessage:\n${text}`;
    const r = await tgSendMessage(ADMIN_CHAT_ID, supportText, { parse_mode: "Markdown" });
    const j = await r.json().catch(() => null);
    if (j?.ok) adminMessageMap.set(j.result.message_id, { customerChatId: chatId });
    s.step = s.prevStep || null;
    s.prevStep = null;
    return tgSendMessage(chatId, "✅ Sent to admin. Please wait for a reply here.");
  }

  // name collection
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
    return tgSendMessage(chatId, "📸 Please upload your payment screenshot.");

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
Scan the QR image above to pay via *QRPh / GCash (Mrs Eyes)*.
After payment, tap *Payment Processed* and upload your proof.
`.trim();

  if (HOST_URL) {
    const qrUrl = `${HOST_URL}/static/qrph.jpg`;
    await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: qrUrl,
        caption: "💰 Scan to pay (QRPh / GCash).",
      }),
    });
  }

  await tgSendMessage(chatId, summary, {
    parse_mode: "Markdown",
    reply_markup: addSupportRow({
      inline_keyboard: [
        [{ text: "💰 Payment Processed", callback_data: "order:confirm" }],
        [{ text: "❌ Cancel", callback_data: "order:cancel" }],
      ],
    }),
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

  const message = [
    "✅ *Thank you!* Payment screenshot received.",
    "🛵 Your Grab delivery link will be generated and sent shortly.",
    "⏳ Please keep this chat open while we process your order.",
  ].join("\n");
  await tgSendMessage(chatId, message, { parse_mode: "Markdown" });
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

  // ADMIN actions
  if (data.startsWith("admin:")) {
    const act = data.split(":")[1];
    if (act === "toggle_shop") {
      SHOP_OPEN = !SHOP_OPEN;
      return tgSendMessage(chatId, SHOP_OPEN ? "🟢 Shop is now OPEN." : "🔴 Shop is now CLOSED.");
    }
    if (act === "logout") {
      loggedInAdmins.delete(chatId);
      return tgSendMessage(chatId, "🔐 Logged out.");
    }
    if (act === "view_orders") {
      if (!orders.length) return tgSendMessage(chatId, "🧾 No orders yet.");
      const list = orders
        .slice(0, 10)
        .map((o) => `#${o.id} ${o.name} — ${o.items.map((i) => i.amount).join(", ")} (${o.createdAt})`)
        .join("\n");
      return tgSendMessage(chatId, `🧾 Recent Orders:\n${list}`);
    }
    if (act === "broadcast") {
      s.prevStep = s.step || null;
      s.step = "await_broadcast";
      return tgSendMessage(chatId, "📢 Send the message to broadcast to all users.");
    }
    if (act === "analytics") {
      const total = orders.length;
      const counts = {};
      for (const o of orders) for (const it of o.items) counts[it.category] = (counts[it.category] || 0) + 1;
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      return tgSendMessage(chatId, `📊 Total orders: ${total}\nTop item: ${top ? `${top[0]} (${top[1]})` : "N/A"}`);
    }
  }

  // SUPPORT connect button
  if (data === "support:connect") {
    s.prevStep = s.step || null;
    s.step = "support_wait_message";
    return tgSendMessage(chatId, "🧑‍💼 Please type your message for the admin:");
  }

  // CUSTOMER actions
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
    session.cart.push({ category: session.category, amount: session.selectedAmount });
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
    return tgSendMessage(chatId, "📸 Please upload your GCash/QRPh payment screenshot.");
  }

  if (data === "order:cancel") {
    sessions.set(chatId, {});
    return tgEditMessageText(chatId, msgId, "❌ Order canceled.");
  }
}

// ───────── WEBHOOK + SERVER ─────────
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
  } catch (err) {
    console.error("❌ Update error:", err);
  }
  res.sendStatus(200);
});

// health / ping
app.get("/", (_, res) => res.send("🧊 IceOrderBot is running (webhook mode)."));
app.get("/ping", (_, res) => res.send("pong"));
app.get("/health", (_, res) =>
  res.json({ ok: true, shop_open: SHOP_OPEN, orders: orders.length, uptime: process.uptime() })
);

// ───────── START SERVER ─────────
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  try {
    await fetchFn(`${TELEGRAM_API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
  } catch (err) {
    console.error("setMyCommands error:", err);
  }
  if (HOST_URL) {
    const webhook = `${HOST_URL}${path}`;
    try {
      await fetchFn(`${TELEGRAM_API}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhook }),
      });
      console.log("✅ Webhook set to:", webhook);
    } catch (err) {
      console.error("Failed to set webhook:", err);
    }
  } else {
    console.warn("⚠️ HOST_URL is not set — set webhook manually if needed.");
  }
});
